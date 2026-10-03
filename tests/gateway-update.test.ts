import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FingerprintBank } from '../src/core/types.js';
import { loadBank } from '../src/data/bank_loader.js';
import { createFingerprintBank } from '../src/data/enrollment.js';
import { loadGatewayBankConfig, parseGatewayBankConfig, type GatewayTarget } from '../src/data/gateway_config.js';
import { planGatewayBankUpdate, readIncrementalBase } from '../src/data/gateway_plan.js';
import { updateGatewayBank } from '../src/data/gateway_update.js';
import { FEATURE_DIMENSION } from '../src/math/ordered_block.js';
import { integerPrompt } from '../src/probes/templates.js';

const credentials = {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_GATEWAY_ID: 'fingerprint-collection',
  CLOUDFLARE_API_TOKEN: 'test-cloudflare-credential-do-not-log',
};
const openrouterCredentials = { OPENROUTER_API_KEY: 'sk-or-v1-test-openrouter-credential-do-not-log' };
const allCredentials = { ...credentials, ...openrouterCredentials };
const now = () => new Date('2026-09-23T00:00:00.000Z');
const CORPUS = /\.corpus-([0-9a-f]{64})\.json$/;

/** Directory entries other than the corpus files that successful collections keep. */
async function entries(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => !CORPUS.test(name));
}

function input() {
  return {
    schemaVersion: 1,
    protocol: { language: 'en', targetSamples: 64, temperature: null },
    checkpoints: [64], trainingRuns: 3, validationRuns: 2,
    timeoutMs: 500, requestDelayMs: 0, maxRequests: 10,
    models: [
      { id: 'reference-a', family: 'gpt', model: 'openai/reference-a' },
      { id: 'reference-b', family: 'claude', model: 'anthropic/reference-b' },
    ],
  };
}

const config = () => parseGatewayBankConfig(input(), credentials);
const openrouterInput = () => ({ ...input(), provider: 'openrouter' });
const openrouterConfig = () => parseGatewayBankConfig(openrouterInput(), openrouterCredentials);

/** The checkpoint digest of a Cloudflare collection as written before OpenRouter support. */
function legacyConfigHash(legacy: ReturnType<typeof config>, transport = 'api'): string {
  return createHash('sha256').update(JSON.stringify({
    collectionVersion: 1, protocol: { ...legacy.protocol, transport },
    prompt: integerPrompt(legacy.protocol.targetSamples, legacy.protocol.language), checkpoints: legacy.checkpoints,
    models: legacy.models.map(({ id, family, model, sampleCount, apiFormat, tokenLimitField, trainingRuns, validationRuns, maxTokens }) =>
      ({ id, family, model, sampleCount, apiFormat, tokenLimitField, trainingRuns, validationRuns, maxTokens })),
    accountId: legacy.gateway!.accountId, gatewayId: legacy.gateway!.gatewayId,
  })).digest('hex');
}

function jsonResponse(payload: unknown, cache = 'MISS'): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) controller.close();
      else { controller.enqueue(bytes.slice(offset, offset + 13)); offset += 13; }
    },
  }), { headers: { 'content-type': 'application/json', 'cf-aig-cache-status': cache } });
}

function response(text: string, finishReason: string | null = 'stop', cache = 'MISS'): Response {
  return jsonResponse({
    choices: [{ index: 0, message: { role: 'assistant', content: text, reasoning_content: '999' }, finish_reason: finishReason }],
    usage: { output_tokens: 12345 },
  }, cache);
}

function formattedResponse(apiFormat: GatewayTarget['apiFormat'], text: string): Response {
  if (apiFormat === 'chat-completions') return response(text);
  if (apiFormat === 'messages') return jsonResponse({
    type: 'message', role: 'assistant', stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '999' }, { type: 'text', text: text.slice(0, 1) }, { type: 'text', text: text.slice(1) }],
  });
  return jsonResponse({
    status: 'completed', error: null, incomplete_details: null,
    output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: '999' }] },
      { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
    ],
    output_text: text, usage: { output_tokens: 12345 },
  });
}

function gateway() {
  const runs = new Map<string, number>();
  return vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    const run = (runs.get(body.model) ?? 0) + 1;
    runs.set(body.model, run);
    const value = (body.model.startsWith('openai/') ? 10 : 200) + run;
    return response(Array<number>(64).fill(value).join(' '));
  });
}

describe('Gateway bank configuration', () => {
  it('reads credentials from environment and supports the gateway name alias', () => {
    const parsed = parseGatewayBankConfig({ ...input(), gateway: { accountId: 'b'.repeat(32), gatewayId: 'file-gateway', apiToken: 'file-token' } }, credentials);
    expect(parsed.gateway?.apiToken).toBe(credentials.CLOUDFLARE_API_TOKEN);
    expect(parsed.gateway?.accountId).toBe(credentials.CLOUDFLARE_ACCOUNT_ID);
    expect(parsed.maxProbeRetries).toBe(0);
    expect(parsed.models[0]).toMatchObject({ trainingRuns: 3, validationRuns: 2, sampleCount: 64, maxTokens: 384, tokenLimitField: 'max_tokens' });
    const alias = parseGatewayBankConfig(input(), { ...credentials, CLOUDFLARE_GATEWAY_ID: '', CLOUDFLARE_GATEWAY_NAME: 'named-gateway' });
    expect(alias.gateway?.gatewayId).toBe('named-gateway');
  });
  it('allows bounded probe retries with an explicit request budget', () => {
    const parsed = parseGatewayBankConfig({ ...input(), maxProbeRetries: 2, maxRequests: 12 }, credentials);
    expect(parsed.maxProbeRetries).toBe(2);
    expect(parsed.maxRequests).toBe(12);
  });
  it('accepts the old retry setting as an alias and rejects conflicting limits', () => {
    expect(parseGatewayBankConfig({ ...input(), maxShortResponseRetries: 2 }, credentials).maxProbeRetries).toBe(2);
    expect(parseGatewayBankConfig({ ...input(), maxProbeRetries: 2, maxShortResponseRetries: 2 }, credentials).maxProbeRetries).toBe(2);
    expect(() => parseGatewayBankConfig({ ...input(), maxProbeRetries: 1, maxShortResponseRetries: 2 }, credentials)).toThrow('must agree');
  });
  it('supports file credentials, per-model run counts, and a shared Chinese protocol', () => {
    const parsed = parseGatewayBankConfig({
      ...input(), gateway: { accountId: credentials.CLOUDFLARE_ACCOUNT_ID, gatewayId: 'file-gateway', apiToken: 'file-token' },
      maxRequests: 20,
      protocol: { language: 'zh', targetSamples: 128, temperature: 0.7 }, checkpoints: [64, 128],
      models: input().models.map((model) => ({ ...model, sampleCount: 128, trainingRuns: 4, validationRuns: 3, tokenLimitField: 'max_completion_tokens', maxTokens: 1024 })),
    }, {});
    expect(parsed.protocol).toEqual({ id: 'integer-v1', language: 'zh', targetSamples: 128, temperature: 0.7, transport: 'api' });
    expect(parsed.models[0]!.trainingRuns).toBe(4);
  });
  it('labels mixed-format collections as api banks, accepting the legacy openai label', () => {
    for (const transport of [undefined, 'api', 'openai']) {
      const raw = { ...input(), protocol: { ...input().protocol, ...(transport ? { transport } : {}) } };
      expect(parseGatewayBankConfig(raw, credentials).protocol.transport).toBe('api');
    }
    expect(() => parseGatewayBankConfig({ ...input(), protocol: { ...input().protocol, transport: 'codex' } }, credentials)).toThrow('api transport label');
  });
  it.each([
    { trainingRuns: 2 }, { validationRuns: 1 }, { timeoutMs: 0 }, { maxRequests: 9 },
    { maxShortResponseRetries: -1 }, { maxShortResponseRetries: 6 }, { maxShortResponseRetries: 1.5 },
    { maxProbeRetries: -1 }, { maxProbeRetries: 6 }, { maxProbeRetries: 1.5 },
    { checkpoints: [64, 64] }, { checkpoints: [] }, { models: [input().models[0]] },
    { protocol: { targetSamples: 63 } }, { protocol: { targetSamples: 64, language: 'fr' } },
    { protocol: { targetSamples: 64, temperature: -1 } }, { protocol: { targetSamples: 64, id: 'other' } },
    { models: input().models.map((model) => ({ ...model, sampleCount: 128 })) },
    { models: input().models.map((model) => ({ ...model, id: 'duplicate' })) },
    { models: input().models.map((model) => ({ ...model, model: 'dynamic/route' })) },
    { misspelledOption: credentials.CLOUDFLARE_API_TOKEN },
  ])('rejects invalid plans before network activity: %j', (override) => {
    expect(() => parseGatewayBankConfig({ ...input(), ...override }, credentials)).toThrow('Invalid bank-update config');
  });
  it('rejects missing credentials and never echoes invalid values', () => {
    expect(() => parseGatewayBankConfig(input(), {})).toThrow('CLOUDFLARE_ACCOUNT_ID');
    try {
      parseGatewayBankConfig(input(), { ...credentials, CLOUDFLARE_GATEWAY_ID: `${credentials.CLOUDFLARE_API_TOKEN}/bad` });
      expect.fail('expected invalid configuration');
    } catch (error) {
      expect(String(error)).not.toContain(credentials.CLOUDFLARE_API_TOKEN);
    }
  });
  it.each([
    ['CLOUDFLARE_ACCOUNT_ID', /CLOUDFLARE_ACCOUNT_ID is not set in the updater's environment; export it/],
    ['CLOUDFLARE_GATEWAY_ID', /CLOUDFLARE_GATEWAY_ID \(or CLOUDFLARE_GATEWAY_NAME\) is not set in the updater's environment; export it/],
    ['CLOUDFLARE_API_TOKEN', /CLOUDFLARE_API_TOKEN is not set in the updater's environment; export it/],
  ])('reports an unset %s as missing, not malformed', (variable, message) => {
    // A shell variable that was sourced but not exported reaches Node as unset.
    expect(() => parseGatewayBankConfig(input(), { ...credentials, [variable]: undefined })).toThrow(message);
  });
  it.each([
    ['environment', { ...credentials, CLOUDFLARE_ACCOUNT_ID: `${'a'.repeat(32)}\r` }, {}, 'CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID (got 33 characters, including whitespace)'],
    ['file', { ...credentials, CLOUDFLARE_ACCOUNT_ID: '' }, { accountId: 'b'.repeat(31) }, 'gateway.accountId must be a 32-character hexadecimal account ID (got 31 characters)'],
    ['environment', { ...credentials, CLOUDFLARE_API_TOKEN: 'secret token' }, {}, 'CLOUDFLARE_API_TOKEN must be a nonempty token without whitespace (got 12 characters, including whitespace)'],
  ] as const)('describes a malformed %s credential without echoing it', (_source, env, gateway, message) => {
    const attempt = () => parseGatewayBankConfig({ ...input(), gateway }, env);
    expect(attempt).toThrow(`Invalid bank-update config: ${message}`);
    expect(attempt).not.toThrow(/aaaa|bbbb|secret/);
  });
  it('accepts Workers AI catalog identifiers', () => {
    const raw = input();
    raw.models[0]!.model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    expect(parseGatewayBankConfig(raw, credentials).models[0]!.model).toMatch(/^@cf\//);
  });
  it('defaults Responses to max_output_tokens and rejects incompatible fields', () => {
    const raw = input();
    const withModel = (extra: Record<string, unknown>) => ({ ...raw, models: [{ ...raw.models[0], ...extra }, raw.models[1]] });
    expect(parseGatewayBankConfig(withModel({ apiFormat: 'responses' }), credentials).models[0])
      .toMatchObject({ apiFormat: 'responses', tokenLimitField: 'max_output_tokens' });
    expect(parseGatewayBankConfig(withModel({ apiFormat: 'messages' }), credentials).models[0])
      .toMatchObject({ apiFormat: 'messages', tokenLimitField: 'max_tokens' });
    for (const extra of [
      { apiFormat: 'invalid' },
      { apiFormat: 'responses', tokenLimitField: 'max_tokens' },
      { apiFormat: 'responses', tokenLimitField: 'max_completion_tokens' },
      { apiFormat: 'messages', tokenLimitField: 'max_completion_tokens' },
      { tokenLimitField: 'max_output_tokens' },
    ]) expect(() => parseGatewayBankConfig(withModel(extra), credentials)).toThrow();
  });
  it('routes models through Cloudflare by default and ignores an unused OpenRouter key', () => {
    const parsed = parseGatewayBankConfig(input(), { ...credentials, OPENROUTER_API_KEY: 'malformed key' });
    expect(parsed.models.map((model) => model.provider)).toEqual(['cloudflare', 'cloudflare']);
    expect(parsed.openrouter).toBeUndefined();
    expect(parseGatewayBankConfig({ ...input(), provider: 'cloudflare' }, credentials)).toEqual(parsed);
  });
  it('routes every model through OpenRouter without Cloudflare credentials', () => {
    const parsed = parseGatewayBankConfig(openrouterInput(), { ...openrouterCredentials, CLOUDFLARE_ACCOUNT_ID: 'malformed' });
    expect(parsed.models.map((model) => model.provider)).toEqual(['openrouter', 'openrouter']);
    expect(parsed.openrouter).toEqual({ apiKey: openrouterCredentials.OPENROUTER_API_KEY });
    expect(parsed.gateway).toBeUndefined();
    const file = { ...openrouterInput(), openrouter: { apiKey: 'file-key' } };
    expect(parseGatewayBankConfig(file, openrouterCredentials).openrouter?.apiKey).toBe(openrouterCredentials.OPENROUTER_API_KEY);
    expect(parseGatewayBankConfig(file, {}).openrouter?.apiKey).toBe('file-key');
  });
  it('mixes providers per model and requires only the credentials in use', () => {
    const raw = { ...input(), models: [input().models[0]!, { ...input().models[1]!, provider: 'openrouter' }] };
    const parsed = parseGatewayBankConfig(raw, allCredentials);
    expect(parsed.models.map((model) => model.provider)).toEqual(['cloudflare', 'openrouter']);
    expect(parsed.gateway?.apiToken).toBe(credentials.CLOUDFLARE_API_TOKEN);
    expect(parsed.openrouter?.apiKey).toBe(openrouterCredentials.OPENROUTER_API_KEY);
    expect(() => parseGatewayBankConfig(raw, credentials)).toThrow(/OPENROUTER_API_KEY is not set in the updater's environment; export it .* or set openrouter\.apiKey$/);
    expect(() => parseGatewayBankConfig(raw, openrouterCredentials)).toThrow('CLOUDFLARE_ACCOUNT_ID is not set');
    // A per-model provider overrides the default in either direction.
    const reversed = { ...openrouterInput(), models: [{ ...input().models[0]!, provider: 'cloudflare' }, input().models[1]!] };
    expect(parseGatewayBankConfig(reversed, allCredentials).models.map((model) => model.provider)).toEqual(['cloudflare', 'openrouter']);
    // The same route may be enrolled once through each provider, but not twice through one.
    const both = { ...input(), models: [input().models[0]!, { ...input().models[0]!, id: 'reference-a-openrouter', provider: 'openrouter' }] };
    expect(parseGatewayBankConfig(both, allCredentials).models.map((model) => model.model)).toEqual(['openai/reference-a', 'openai/reference-a']);
    const duplicate = { ...openrouterInput(), models: [input().models[0]!, { ...input().models[0]!, id: 'reference-a-copy' }] };
    expect(() => parseGatewayBankConfig(duplicate, openrouterCredentials)).toThrow('catalog identifiers must be unique');
  });
  it('accepts pinned OpenRouter variants and rejects routers, floating aliases, and prompt-altering variants', () => {
    const withRoute = (model: string) => ({ ...openrouterInput(), models: [{ ...input().models[0]!, model }, input().models[1]!] });
    for (const model of ['meta-llama/llama-3.3-70b-instruct:free', 'x-ai/grok-4.1', 'anthropic/claude-opus-5:thinking', 'openrouter/stealth-alpha']) {
      expect(parseGatewayBankConfig(withRoute(model), openrouterCredentials).models[0]!.model).toBe(model);
    }
    for (const model of [
      'openrouter/auto', 'openrouter/auto:floor', 'openrouter/free', 'openai/gpt-6-sol:online', '~anthropic/claude-opus-latest',
      '@preset/probe', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'openai/gpt-6-sol:', 'openai/a:b:c', 'openai/../secret', 'openai/',
    ]) expect(() => parseGatewayBankConfig(withRoute(model), openrouterCredentials), model).toThrow('Invalid bank-update config');
  });
  it.each([
    { provider: 'anthropic' },
    { models: [{ ...input().models[0]!, provider: 'openai' }, input().models[1]!] },
    { openrouter: { apiKey: 'key', misspelledOption: 'value' } },
    { openrouter: 'key' },
  ])('rejects an invalid provider setting: %j', (override) => {
    expect(() => parseGatewayBankConfig({ ...openrouterInput(), ...override }, allCredentials)).toThrow('Invalid bank-update config');
  });
  it.each([
    ['environment', { OPENROUTER_API_KEY: 'secret key' }, {}, 'OPENROUTER_API_KEY must be a nonempty key without whitespace (got 10 characters, including whitespace)'],
    ['file', { OPENROUTER_API_KEY: '' }, { apiKey: 'secret\tkey' }, 'openrouter.apiKey must be a nonempty key without whitespace (got 10 characters, including whitespace)'],
  ] as const)('describes a malformed %s OpenRouter key without echoing it', (_source, env, openrouter, message) => {
    const attempt = () => parseGatewayBankConfig({ ...openrouterInput(), openrouter }, env);
    expect(attempt).toThrow(`Invalid bank-update config: ${message}`);
    expect(attempt).not.toThrow(/secret/);
  });
});

describe('Gateway collection and atomic bank updates', () => {
  let directory: string;
  let outputPath: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'logitping-bank-update-'));
    outputPath = join(directory, 'default_bank.json');
    await writeFile(outputPath, 'previous-bank-bytes\n');
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('collects uncached, independent train/validation JSON responses and writes the enrollment result', async () => {
    const fetch = gateway();
    const onProgress = vi.fn();
    const result = await updateGatewayBank(config(), { outputPath, fetch, now, onProgress });
    expect(result.changed).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(onProgress).toHaveBeenCalledTimes(10);
    expect(onProgress.mock.calls.map(([progress]) => progress.phase)).toEqual([...Array(6).fill('training'), ...Array(4).fill('validation')]);
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/${credentials.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`);
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${credentials.CLOUDFLARE_API_TOKEN}`);
      expect(headers.get('cf-aig-gateway-id')).toBe(credentials.CLOUDFLARE_GATEWAY_ID);
      expect(headers.get('cf-aig-skip-cache')).toBe('true');
      expect(headers.get('cf-aig-max-attempts')).toBe('1');
      expect(headers.get('accept')).toBe('application/json');
      expect(init?.redirect).toBe('error');
      const body = JSON.parse(String(init?.body));
      expect(body.messages).toEqual([{ role: 'user', content: integerPrompt(64, 'en') }]);
      expect(body.stream).toBe(false);
      expect(body.temperature).toBeUndefined();
    }
    const expected = createFingerprintBank({
      source: 'Expected fixture', protocol: config().protocol, checkpoints: [64],
      models: input().models.map((model, index) => ({
        id: model.id, family: model.family,
        training: [1, 2, 3].map((n) => Array<number>(64).fill((index ? 200 : 10) + n)),
        validation: [4, 5].map((n) => Array<number>(64).fill((index ? 200 : 10) + n)),
      })),
    });
    const saved = await loadBank(outputPath);
    expect(saved.models.map((model) => model.profiles)).toEqual(expected.models.map((model) => model.profiles));
    expect(saved.models.map((model) => model.integerProbabilities)).toEqual(expected.models.map((model) => model.integerProbabilities));
    expect(saved.calibration).toMatchObject({ heldOutRuns: 4, sequentialValidated: false });
    expect(saved.calibration?.source).toContain('2026-09-23T00:00:00.000Z');
    expect(saved.models[1]!.provenance).toContain('anthropic/reference-b');
    const text = await readFile(outputPath, 'utf8');
    for (const credential of Object.values(credentials)) expect(text).not.toContain(credential);
    expect(await entries(directory)).toEqual(['default_bank.json']);
    // The kept corpus reproduces the digest that provenance records, and holds no credentials.
    const [corpusName] = (await readdir(directory)).filter((name) => CORPUS.test(name));
    const digest = corpusName!.match(CORPUS)![1]!;
    const corpus = JSON.parse(await readFile(join(directory, corpusName!), 'utf8'));
    const { protocol, checkpoints, models } = corpus;
    expect(createHash('sha256').update(JSON.stringify({ protocol, checkpoints, models })).digest('hex')).toBe(digest);
    expect(models[0].training).toEqual([1, 2, 3].map((n) => Array<number>(64).fill(10 + n)));
    for (const model of saved.models) expect(model.provenance).toContain(`corpus sha256:${digest};`);
    for (const credential of Object.values(credentials)) expect(JSON.stringify(corpus)).not.toContain(credential);
  });

  it('honors per-model counts, language, temperature, and token budget', async () => {
    const custom = config();
    custom.protocol.language = 'zh';
    custom.protocol.temperature = 0.8;
    custom.models[0]!.trainingRuns = 4;
    custom.models[0]!.validationRuns = 3;
    custom.models[0]!.tokenLimitField = 'max_completion_tokens';
    custom.models[0]!.maxTokens = 2048;
    custom.maxRequests = 12;
    const fetch = gateway();
    await updateGatewayBank(custom, { outputPath, fetch, now });
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.filter((body) => body.model === 'openai/reference-a')).toHaveLength(7);
    expect(bodies.filter((body) => body.model === 'anthropic/reference-b')).toHaveLength(5);
    expect(bodies[0]).toMatchObject({ temperature: 0.8, max_completion_tokens: 2048, messages: [{ role: 'user', content: integerPrompt(64, 'zh') }] });
  });

  it('enrolls all three API formats with the same integer prompt and Cloudflare auth', async () => {
    const custom = config();
    custom.models.push({ ...custom.models[0]!, id: 'reference-c', model: 'openai/reference-c' });
    custom.maxRequests = 15;
    custom.models[0]!.apiFormat = 'responses';
    custom.models[0]!.tokenLimitField = 'max_output_tokens';
    custom.models[1]!.apiFormat = 'messages';
    custom.models[1]!.maxTokens = 8192;
    const chat = gateway();
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).endsWith('/messages')) return formattedResponse('messages', '200 '.repeat(64));
      if (!String(url).endsWith('/responses')) return chat(url, init);
      return formattedResponse('responses', '17 '.repeat(64));
    });
    const { bank } = await updateGatewayBank(custom, { outputPath, fetch, now });
    expect(bank.models[0]!.provenance).toContain('api=responses');
    expect(bank.models[1]!.provenance).toContain('api=messages');
    expect(bank.models[2]!.provenance).toContain('api=chat-completions');
    expect(fetch).toHaveBeenCalledTimes(15);
    for (const [url, init] of fetch.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${credentials.CLOUDFLARE_API_TOKEN}`);
      expect(headers.has('x-api-key')).toBe(false);
      expect(headers.get('accept')).toBe('application/json');
      const body = JSON.parse(String(init?.body));
      expect(body.stream).toBe(false);
      const messages = [{ role: 'user', content: integerPrompt(64, 'en') }];
      if (String(url).endsWith('/responses')) {
        expect(body).toMatchObject({ input: messages, max_output_tokens: 384, store: false, stream: false });
        expect(body.messages).toBeUndefined();
        expect(body.max_tokens).toBeUndefined();
      } else {
        expect(body.messages).toEqual(messages);
        if (String(url).endsWith('/messages')) expect(body.max_tokens).toBe(8192);
      }
    }
    expect(bank.calibration?.sequentialValidated).toBe(false);
  });

  it('does not rewrite unchanged content', async () => {
    await updateGatewayBank(config(), { outputPath, fetch: gateway(), now });
    const before = await stat(outputPath);
    const result = await updateGatewayBank(config(), { outputPath, fetch: gateway(), now });
    expect(result.changed).toBe(false);
    expect((await stat(outputPath)).mtimeMs).toBe(before.mtimeMs);
  });

  it.each(['chat-completions', 'responses', 'messages'] as const)(
    'calibrates only the first 512 integers of overlong %s training and validation runs', async (apiFormat) => {
      const custom = parseGatewayBankConfig({
        ...input(), protocol: { ...input().protocol, targetSamples: 512 }, checkpoints: [64, 128, 256, 512],
        models: input().models.map((model) => ({ ...model, apiFormat })),
      }, credentials);
      const prefix = (modelIndex: number, run: number) =>
        Array.from({ length: 512 }, (_, index) => (index * 7 + run * 13 + modelIndex * 101) % 300 + 1);
      const runs = new Map<string, number>();
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        const { model } = JSON.parse(String(init?.body)) as { model: string };
        const run = (runs.get(model) ?? 0) + 1;
        runs.set(model, run);
        const text = prefix(custom.models.findIndex((target) => target.model === model), run).join(' ');
        // Include surplus values both with and without a final separator.
        return formattedResponse(apiFormat, text + (run % 2 ? ' 355 1' : ' 355 1 '));
      });
      const expected = createFingerprintBank({
        source: 'Expected prefixes', protocol: custom.protocol, checkpoints: custom.checkpoints,
        models: custom.models.map((model, index) => ({
          id: model.id, family: model.family,
          training: [1, 2, 3].map((run) => prefix(index, run)),
          validation: [4, 5].map((run) => prefix(index, run)),
        })),
      });
      const result = await updateGatewayBank(custom, { outputPath, fetch, now });
      expect(result.requests).toBe(10);
      expect(fetch).toHaveBeenCalledTimes(10);
      const saved = await loadBank(outputPath);
      for (const [index, model] of saved.models.entries()) {
        expect(model.profiles).toEqual(expected.models[index]!.profiles);
        expect(model.integerProbabilities).toEqual(expected.models[index]!.integerProbabilities);
        expect(model.provenance).toContain('sampling=first-512');
        expect(model.provenance).toContain('stream=false');
      }
      expect(saved.calibration).toMatchObject({ heldOutRuns: 4, sequentialValidated: false });
    },
  );

  it.each([
    ['training', 'short'], ['validation', 'short'], ['training', 'invalid'], ['validation', 'invalid'],
  ] as const)('replaces a %s response that is %s with a fresh 512-integer run', async (phase, reason) => {
    const custom = parseGatewayBankConfig({
      ...input(), protocol: { ...input().protocol, targetSamples: 512 }, checkpoints: [64, 128, 256, 512],
      maxRequests: 12, maxProbeRetries: 2,
      models: input().models.map((model) => ({ ...model, apiFormat: 'responses' })),
    }, credentials);
    const runs = new Map<string, number>();
    // Retain only the user's assistant integer text, excluding reasoning and account metadata.
    const rejectedText = reason === 'short' ? Array(511).fill(355).join(' ')
      : await readFile(new URL('./fixtures/terra-out-of-range.txt', import.meta.url), 'utf8');
    let rejectedSent = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const { model } = JSON.parse(String(init?.body)) as { model: string };
      const run = (runs.get(model) ?? 0) + 1;
      if (model === custom.models[0]!.model && run === (phase === 'training' ? 1 : 4) && !rejectedSent) {
        rejectedSent = true;
        return formattedResponse('responses', rejectedText);
      }
      runs.set(model, run);
      return formattedResponse('responses', Array(512).fill((model === custom.models[0]!.model ? 10 : 200) + run).join(' '));
    });
    const onRetry = vi.fn();
    const onProgress = vi.fn();
    const result = await updateGatewayBank(custom, { outputPath, fetch, now, onRetry, onProgress });
    expect(result.requests).toBe(11);
    expect(fetch).toHaveBeenCalledTimes(11);
    expect(onProgress).toHaveBeenCalledTimes(10);
    expect(onProgress.mock.lastCall?.[0]).toMatchObject({ completedRequests: 10, totalRequests: 10, requestsSent: 11 });
    expect(onRetry).toHaveBeenCalledExactlyOnceWith({
      modelId: 'reference-a', phase, run: 1, attempt: 2, maxAttempts: 3,
      reason, expectedSamples: 512, requestsSent: phase === 'training' ? 1 : 7,
      ...(reason === 'short' ? { receivedSamples: 511, message: 'Incomplete probe: received 511 of 512 integers' }
        : { invalidPosition: 306, message: 'Invalid integer output at position 306: 356 is outside [1, 355]' }),
    });
    const failedIndex = phase === 'training' ? 0 : 6;
    expect(fetch.mock.calls[failedIndex]![1]?.body).toBe(fetch.mock.calls[failedIndex + 1]![1]?.body);
    for (const [, init] of fetch.mock.calls) {
      expect(JSON.parse(String(init?.body))).toMatchObject({ stream: false, input: [{ role: 'user', content: integerPrompt(512, 'en') }] });
    }
    const expected = createFingerprintBank({
      source: 'Fresh complete runs', protocol: custom.protocol, checkpoints: custom.checkpoints,
      models: custom.models.map((model, index) => ({
        id: model.id, family: model.family,
        training: [1, 2, 3].map((run) => Array<number>(512).fill((index ? 200 : 10) + run)),
        validation: [4, 5].map((run) => Array<number>(512).fill((index ? 200 : 10) + run)),
      })),
    });
    const saved = await loadBank(outputPath);
    expect(saved.models.map((model) => model.profiles)).toEqual(expected.models.map((model) => model.profiles));
    expect(saved.models.map((model) => model.integerProbabilities)).toEqual(expected.models.map((model) => model.integerProbabilities));
    expect(saved.models[0]!.provenance).toContain(`${reason}-${phase}-responses=1`);
    expect(saved.models[0]!.provenance).toContain('retries=1;');
    expect(saved.models[1]!.provenance).toContain('retries=0;');
    expect(saved.calibration).toMatchObject({ heldOutRuns: 4, sequentialValidated: false });
  });

  it.each([
    '17 356 42',
    '17 0 42',
    '17 18 private-model-prose',
    '17 '.repeat(64) + '356',
    '17 '.repeat(64) + 'private-model-prose',
    '17 '.repeat(64) + 'private-model-prose'.repeat(3),
  ])('retries malformed or out-of-range integer output, including beyond the retained prefix (%#)', async (text) => {
    const custom = { ...config(), maxRequests: 12, maxProbeRetries: 2 };
    const fetch = gateway().mockImplementationOnce(async () => response(text));
    const onRetry = vi.fn();
    const result = await updateGatewayBank(custom, { outputPath, fetch, now, onRetry });
    expect(result.requests).toBe(11);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ reason: 'invalid', attempt: 2, maxAttempts: 3 });
    expect(onRetry.mock.calls[0]![0].message).not.toContain('private-model-prose');
    expect(result.bank.models[0]!.provenance).toContain('invalid-training-responses=1');
    expect(result.bank.models[0]!.provenance).toContain('retries=1;');
  });

  it('records both rejection reasons when a run succeeds after invalid and short replies', async () => {
    const custom = { ...config(), maxRequests: 12, maxProbeRetries: 2 };
    const fetch = gateway().mockImplementationOnce(async () => response('17 356'))
      .mockImplementationOnce(async () => response('17 '.repeat(63)));
    const onRetry = vi.fn();
    const result = await updateGatewayBank(custom, { outputPath, fetch, now, onRetry });
    expect(result.requests).toBe(12);
    expect(onRetry.mock.calls.map(([retry]) => [retry.reason, retry.attempt])).toEqual([['invalid', 2], ['short', 3]]);
    expect(result.bank.models[0]!.provenance).toContain('retries=2;');
    expect(result.bank.models[0]!.provenance).toContain('short-training-responses=1');
    expect(result.bank.models[0]!.provenance).toContain('invalid-training-responses=1');
  });

  it.each([
    [20, 0, 1, 'retry limit reached'],
    [20, 2, 3, 'retry limit reached'],
    [10, 2, 1, 'no retry budget remains'],
    [11, 2, 2, 'no retry budget remains'],
  ] as const)('stops within the retry and total request budgets (%#)', async (maxRequests, maxProbeRetries, expectedRequests, message) => {
    const custom = { ...config(), maxRequests, maxProbeRetries };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response('17 '.repeat(63)));
    const onRetry = vi.fn();
    await expect(updateGatewayBank(custom, { outputPath, fetch, now, onRetry })).rejects.toThrow(message);
    expect(fetch).toHaveBeenCalledTimes(expectedRequests);
    expect(onRetry).toHaveBeenCalledTimes(expectedRequests - 1);
    expect(await readFile(outputPath, 'utf8')).toBe('previous-bank-bytes\n');
    expect(await readdir(directory)).toEqual(['default_bank.json', 'default_bank.json.checkpoint.json']);
  });

  it.each([
    [20, 0, 1, 'retry limit reached'],
    [20, 2, 3, 'retry limit reached'],
    [10, 2, 1, 'no retry budget remains'],
    [11, 2, 2, 'no retry budget remains'],
  ] as const)('shares one retry budget across invalid and short replies (%#)', async (maxRequests, maxProbeRetries, expectedRequests, message) => {
    const custom = { ...config(), maxRequests, maxProbeRetries };
    let attempts = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(++attempts % 2 ? '17 356' : '17 '.repeat(63)));
    const onRetry = vi.fn();
    await expect(updateGatewayBank(custom, { outputPath, fetch, now, onRetry })).rejects.toThrow(message);
    expect(fetch).toHaveBeenCalledTimes(expectedRequests);
    expect(onRetry).toHaveBeenCalledTimes(expectedRequests - 1);
    expect(await readFile(outputPath, 'utf8')).toBe('previous-bank-bytes\n');
    expect(await readdir(directory)).toEqual(['default_bank.json', 'default_bank.json.checkpoint.json']);
  });

  it('honors cancellation during the delay before a short-response retry', async () => {
    const controller = new AbortController();
    const custom = { ...config(), maxRequests: 12, maxProbeRetries: 2, requestDelayMs: 1000 };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response('17 '.repeat(63)));
    const onRetry = () => { controller.abort(new Error('User interrupted retry')); };
    await expect(updateGatewayBank(custom, { outputPath, fetch, now, onRetry, signal: controller.signal })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    expect(await readFile(outputPath, 'utf8')).toBe('previous-bank-bytes\n');
    expect(await readdir(directory)).toEqual(['default_bank.json', 'default_bank.json.checkpoint.json']);
  });

  it('preserves the bank and reports the configured budget when Messages hits max_tokens', async () => {
    const custom = { ...config(), maxRequests: 12, maxProbeRetries: 2 };
    custom.models[0]!.apiFormat = 'messages';
    custom.models[0]!.maxTokens = 8192;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({
      type: 'message', role: 'assistant', stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '17 '.repeat(64) }],
    }));
    const onRetry = vi.fn();
    await expect(updateGatewayBank(custom, { outputPath, fetch, now, onRetry }))
      .rejects.toThrow('reference-a training run 1: Probe response hit the output token limit (stop_reason=max_tokens; maxTokens=8192)');
    expect(fetch).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ stream: false, max_tokens: 8192 });
    expect(await readFile(outputPath, 'utf8')).toBe('previous-bank-bytes\n');
    expect(await readdir(directory)).toEqual(['default_bank.json', 'default_bank.json.checkpoint.json']);
  });

  it.each([
    ['short response', () => response('17 '.repeat(63))],
    ['truncated completion', () => response('17 '.repeat(64), 'length')],
    ['truncated overlong completion', () => response('17 '.repeat(65), 'length')],
    ['missing finish reason', () => response('17 '.repeat(64), null)],
    ['missing finish reason after surplus integers', () => response('17 '.repeat(65), null)],
    ['cache hit', () => response('17 '.repeat(64), 'stop', 'HIT')],
    ['HTTP failure', () => new Response(credentials.CLOUDFLARE_API_TOKEN, { status: 429 })],
  ] as const)('preserves the previous bank after a %s without retrying', async (_name, makeResponse) => {
    const custom = _name === 'short response' ? config() : { ...config(), maxRequests: 12, maxProbeRetries: 2 };
    const fetch = gateway().mockImplementationOnce(async () => response('17 '.repeat(64)))
      .mockImplementationOnce(async () => makeResponse());
    await expect(updateGatewayBank(custom, { outputPath, fetch, now })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await readFile(outputPath, 'utf8')).toBe('previous-bank-bytes\n');
    expect(await readdir(directory)).toEqual(['default_bank.json', 'default_bank.json.checkpoint.json']);
  });

  it.each([
    ['{broken', 'application/json', 'Malformed JSON'],
    ['data: [DONE]\n\n', 'text/event-stream', 'Expected a non-streaming JSON response'],
  ])('rejects invalid JSON or unexpected SSE and removes temporary files (%#)', async (body, contentType, message) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body, { headers: { 'content-type': contentType! } }));
    await expect(updateGatewayBank(config(), { outputPath, fetch, now })).rejects.toThrow(message);
    expect(fetch).toHaveBeenCalledOnce();
    expect(await readFile(outputPath, 'utf8')).toBe('previous-bank-bytes\n');
    expect(await readdir(directory)).toEqual(['default_bank.json', 'default_bank.json.checkpoint.json']);
  });

  it('redacts credentials even from an injected network exception', async () => {
    const fetch: typeof globalThis.fetch = async () => { throw new Error(Object.values(credentials).join(' ')); };
    try { await updateGatewayBank(config(), { outputPath, fetch, now }); expect.fail('expected failure'); }
    catch (error) {
      for (const credential of Object.values(credentials)) expect(String(error)).not.toContain(credential);
      expect(String(error)).toContain('[redacted]');
    }
  });

  it('redacts a private gateway name only as a whole identifier, never in its own context', async () => {
    const custom = parseGatewayBankConfig(input(), { ...credentials, CLOUDFLARE_GATEWAY_ID: 'run' });
    const fetch: typeof globalThis.fetch = async () => { throw new Error('gateway run unavailable; truncated'); };
    await expect(updateGatewayBank(custom, { outputPath, fetch, now }))
      .rejects.toThrow(/^reference-a training run 1: gateway \[redacted\] unavailable; truncated$/);
  });

  it('reports probe rejections verbatim when the gateway name is a number', async () => {
    const custom = { ...parseGatewayBankConfig(input(), { ...credentials, CLOUDFLARE_GATEWAY_ID: '1' }), maxRequests: 12, maxProbeRetries: 2 };
    const fetch = gateway().mockImplementationOnce(async () => response('17 356'));
    const onRetry = vi.fn();
    await updateGatewayBank(custom, { outputPath, fetch, now, onRetry });
    expect(onRetry.mock.calls[0]![0].message).toBe('Invalid integer output at position 2: 356 is outside [1, 355]');
  });

  it('aborts an in-flight request and preserves the old bank', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      controller.abort(new Error('User interrupted collection'));
    }));
    await expect(updateGatewayBank(config(), { outputPath, fetch, now, signal: controller.signal })).rejects.toThrow('User interrupted collection');
    expect(await readFile(outputPath, 'utf8')).toBe('previous-bank-bytes\n');
    expect(await readdir(directory)).toEqual(['default_bank.json', 'default_bank.json.checkpoint.json']);
  });

  it('enforces the request deadline', async () => {
    const short = config(); short.timeoutMs = 10;
    const fetch: typeof globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
    await expect(updateGatewayBank(short, { outputPath, fetch, now })).rejects.toThrow('timed out');
    expect(await readFile(outputPath, 'utf8')).toBe('previous-bank-bytes\n');
  });

  it('refuses overlapping updates before sending any requests', async () => {
    const fetch = gateway();
    await writeFile(`${outputPath}.lock`, 'another process');
    await expect(updateGatewayBank(config(), { outputPath, fetch, now })).rejects.toThrow('output lock');
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(`${outputPath}.lock`, 'utf8')).toBe('another process');
  });

  it('preserves an edit made by another writer during collection', async () => {
    const fetch = gateway();
    fetch.mockImplementationOnce(async () => {
      await writeFile(outputPath, 'concurrent edit');
      return response('17 '.repeat(64));
    });
    await expect(updateGatewayBank(config(), { outputPath, fetch, now })).rejects.toThrow('Bank changed during collection');
    expect(await readFile(outputPath, 'utf8')).toBe('concurrent edit');
    expect(await readdir(directory)).toEqual(['default_bank.json', 'default_bank.json.checkpoint.json']);
  });

  it('creates a new destination and loads configuration from a file', async () => {
    const file = join(directory, 'config.json');
    await writeFile(file, JSON.stringify(input()));
    const loaded = await loadGatewayBankConfig(file, credentials);
    const newPath = join(directory, 'new', 'bank.json');
    await updateGatewayBank(loaded, { outputPath: newPath, fetch: gateway(), now });
    expect((await loadBank(newPath)).models).toHaveLength(2);
    await writeFile(file, '{ invalid');
    await expect(loadGatewayBankConfig(file, credentials)).rejects.toThrow('not valid JSON');
  });

  it.each([
    ['chat-completions', 3], ['chat-completions', 8],
    ['responses', 3], ['responses', 8], ['messages', 3], ['messages', 8],
  ] as const)('resumes %s after request %i without repeating successful runs', async (apiFormat, failAt) => {
    const custom = parseGatewayBankConfig({
      ...input(), maxRequests: 11, models: input().models.map((model) => ({ ...model, apiFormat })),
    }, credentials);
    const runs = new Map<string, number>();
    let attempts = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      // The request reservation must already be durable when the network call starts.
      expect(JSON.parse(await readFile(`${outputPath}.checkpoint.json`, 'utf8')).requestsSent).toBe(++attempts);
      if (attempts === failAt) return new Response('private provider error', { status: 503 });
      const body = JSON.parse(String(init?.body));
      expect(body.stream).toBe(false);
      const run = (runs.get(body.model) ?? 0) + 1;
      runs.set(body.model, run);
      return formattedResponse(apiFormat, Array(64).fill((body.model.startsWith('openai/') ? 10 : 200) + run).join(' '));
    });
    await expect(updateGatewayBank(custom, { outputPath, fetch, now })).rejects.toThrow('HTTP 503');
    const checkpoint = `${outputPath}.checkpoint.json`;
    const savedText = await readFile(checkpoint, 'utf8');
    const saved = JSON.parse(savedText);
    expect(saved.requestsSent).toBe(failAt);
    expect(saved.models.reduce((n: number, m: { training: unknown[]; validation: unknown[] }) => n + m.training.length + m.validation.length, 0)).toBe(failAt - 1);
    expect((await stat(checkpoint)).mode & 0o777).toBe(0o600);
    for (const secret of [...Object.values(credentials), 'private provider error', 'reasoning_content', 'thinking']) {
      expect(savedText).not.toContain(secret);
    }
    expect(await readFile(outputPath, 'utf8')).toBe('previous-bank-bytes\n');
    const onResume = vi.fn();
    const onProgress = vi.fn();
    const result = await updateGatewayBank(custom, {
      outputPath, fetch, now: () => new Date('2026-09-24T00:00:00.000Z'), onResume, onProgress,
    });
    expect(onResume).toHaveBeenCalledExactlyOnceWith({
      checkpointPath: checkpoint, completedRequests: failAt - 1, totalRequests: 10, requestsSent: failAt,
    });
    expect(result).toMatchObject({ resumedRuns: failAt - 1, requests: 11, requestsThisRun: 11 - failAt });
    expect(fetch).toHaveBeenCalledTimes(11);
    expect(fetch.mock.calls[failAt]![1]?.body).toBe(fetch.mock.calls[failAt - 1]![1]?.body);
    expect(onProgress.mock.calls[0]![0].completedRequests).toBe(failAt);
    expect(onProgress.mock.calls.map(([progress]) => progress.phase)).toEqual(
      [...Array(6).fill('training'), ...Array(4).fill('validation')].slice(failAt - 1),
    );
    const expected = createFingerprintBank({
      source: 'Expected uninterrupted corpus', protocol: custom.protocol, checkpoints: custom.checkpoints,
      models: custom.models.map((model, index) => ({
        id: model.id, family: model.family,
        training: [1, 2, 3].map((n) => Array<number>(64).fill((index ? 200 : 10) + n)),
        validation: [4, 5].map((n) => Array<number>(64).fill((index ? 200 : 10) + n)),
      })),
    });
    expect(result.bank.models.map((model) => model.profiles)).toEqual(expected.models.map((model) => model.profiles));
    expect(result.bank.models.map((model) => model.integerProbabilities)).toEqual(expected.models.map((model) => model.integerProbabilities));
    expect(result.bank.calibration?.source).toContain(now().toISOString());
    expect(await entries(directory)).toEqual(['default_bank.json']);
  });

  it('carries rejected attempts across repeated resumes and allows explicit operational changes', async () => {
    const custom = { ...config(), maxRequests: 12 };
    await expect(updateGatewayBank(custom, {
      outputPath, now, fetch: vi.fn(async () => response('17 356')),
    })).rejects.toThrow('retry limit reached');
    await expect(updateGatewayBank(custom, {
      outputPath, now, fetch: vi.fn(async () => response('17 '.repeat(63))),
    })).rejects.toThrow('retry limit reached');
    const fetch = gateway();
    await expect(updateGatewayBank({ ...custom, maxRequests: 11 }, { outputPath, fetch, now }))
      .rejects.toThrow('Saved request budget cannot cover');
    expect(fetch).not.toHaveBeenCalled();
    const result = await updateGatewayBank({
      ...custom, timeoutMs: 2000, maxProbeRetries: 2, requestDelayMs: 1,
      gateway: { ...custom.gateway!, apiToken: 'rotated-test-token' },
    }, { outputPath, fetch, now });
    expect(result).toMatchObject({ requests: 12, requestsThisRun: 10 });
    expect(result.bank.models[0]!.provenance).toContain('invalid-training-responses=1');
    expect(result.bank.models[0]!.provenance).toContain('short-training-responses=1');
    expect(result.bank.models[0]!.provenance).toContain('retries=2;');
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer rotated-test-token');
  });

  it('saves completed runs on cancellation and counts an interrupted request when resumed', async () => {
    const custom = { ...config(), maxRequests: 11 };
    const controller = new AbortController();
    const good = gateway();
    let attempts = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (++attempts !== 4) return good(url, init);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        controller.abort(new Error('User stopped collection'));
      });
    });
    await expect(updateGatewayBank(custom, { outputPath, fetch, now, signal: controller.signal })).rejects.toThrow('User stopped');
    expect(JSON.parse(await readFile(`${outputPath}.checkpoint.json`, 'utf8')).requestsSent).toBe(4);
    const result = await updateGatewayBank(custom, { outputPath, fetch, now });
    expect(result).toMatchObject({ resumedRuns: 3, requests: 11, requestsThisRun: 7 });
    expect(fetch).toHaveBeenCalledTimes(11);
  });

  it('can publish a fully collected checkpoint without making more requests', async () => {
    const fetch = gateway();
    await expect(updateGatewayBank(config(), {
      outputPath, fetch, now,
      onProgress: ({ completedRequests }) => { if (completedRequests === 10) throw new Error('Process interrupted before publication'); },
    })).rejects.toThrow('before publication');
    expect(await readFile(outputPath, 'utf8')).toBe('previous-bank-bytes\n');
    fetch.mockClear();
    const result = await updateGatewayBank(config(), { outputPath, fetch, now });
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ resumedRuns: 10, requests: 10, requestsThisRun: 0, changed: true });
    expect(await entries(directory)).toEqual(['default_bank.json']);
  });

  it.each(['model', 'protocol', 'token budget', 'format', 'gateway', 'provider', 'counts', 'checkpoints'])(
    'refuses incompatible %s changes before requests, preserving saved progress', async (change) => {
      await expect(updateGatewayBank(config(), {
        outputPath, fetch: gateway(), now, onProgress: () => { throw new Error('Pause after saved run'); },
      })).rejects.toThrow('Pause');
      const saved = await readFile(`${outputPath}.checkpoint.json`, 'utf8');
      const custom = { ...config(), maxRequests: 20 };
      if (change === 'model') custom.models[0]!.model = 'openai/other-reference';
      if (change === 'protocol') custom.protocol.temperature = 0.5;
      if (change === 'token budget') custom.models[0]!.maxTokens++;
      if (change === 'format') custom.models[0]!.apiFormat = 'messages';
      if (change === 'gateway') custom.gateway!.gatewayId = 'other-gateway';
      if (change === 'provider') {
        custom.models[0]!.provider = 'openrouter';
        custom.openrouter = { apiKey: openrouterCredentials.OPENROUTER_API_KEY };
      }
      if (change === 'counts') custom.models[0]!.trainingRuns++;
      if (change === 'checkpoints') {
        custom.protocol.targetSamples = 128;
        custom.checkpoints = [64, 128];
        for (const model of custom.models) model.sampleCount = 128;
      }
      const fetch = gateway();
      await expect(updateGatewayBank(custom, { outputPath, fetch, now })).rejects.toThrow('does not match');
      expect(fetch).not.toHaveBeenCalled();
      expect(await readFile(`${outputPath}.checkpoint.json`, 'utf8')).toBe(saved);
    },
  );

  it.each(['JSON', 'samples', 'counts', 'schedule', 'version'])(
    'rejects corrupt checkpoint %s without silently restarting or leaking contents', async (corruption) => {
      await expect(updateGatewayBank(config(), {
        outputPath, fetch: gateway(), now, onProgress: () => { throw new Error('Pause'); },
      })).rejects.toThrow('Pause');
      const path = `${outputPath}.checkpoint.json`;
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (corruption === 'samples') value.models[0].training[0][0] = 356;
      if (corruption === 'counts') value.requestsSent = 0;
      if (corruption === 'schedule') value.models[1].training = value.models[0].training.splice(0);
      if (corruption === 'version') value.schemaVersion = 999;
      const broken = corruption === 'JSON' ? `{"private": ${credentials.CLOUDFLARE_API_TOKEN}` : JSON.stringify(value);
      await writeFile(path, broken);
      const fetch = gateway();
      await expect(updateGatewayBank(config(), { outputPath, fetch, now })).rejects.toThrow(/^Invalid bank checkpoint;/);
      expect(fetch).not.toHaveBeenCalled();
      expect(await readFile(path, 'utf8')).toBe(broken);
      expect(await readFile(outputPath, 'utf8')).toBe('previous-bank-bytes\n');
    },
  );

  it('resumes a checkpoint saved before gateway banks used the api label', async () => {
    await expect(updateGatewayBank(config(), {
      outputPath, fetch: gateway(), now, onProgress: () => { throw new Error('Pause'); },
    })).rejects.toThrow('Pause');
    const path = `${outputPath}.checkpoint.json`;
    const saved = JSON.parse(await readFile(path, 'utf8'));
    // The configuration digest written by versions that labeled gateway banks `openai`.
    saved.configHash = legacyConfigHash(config(), 'openai');
    await writeFile(path, JSON.stringify(saved));
    const fetch = gateway();
    await expect(updateGatewayBank(config(), {
      outputPath, fetch, now, onProgress: () => { throw new Error('Pause again'); },
    })).rejects.toThrow('Pause again');
    expect(JSON.parse(await readFile(path, 'utf8')).configHash).not.toBe(saved.configHash);
    const result = await updateGatewayBank(config(), { outputPath, fetch, now });
    expect(result).toMatchObject({ resumedRuns: 2, requests: 10, requestsThisRun: 8 });
    expect(fetch).toHaveBeenCalledTimes(9);
  });

  it('keeps the checkpoint digest of Cloudflare collections saved before OpenRouter support', async () => {
    await expect(updateGatewayBank(config(), {
      outputPath, fetch: gateway(), now, onProgress: () => { throw new Error('Pause'); },
    })).rejects.toThrow('Pause');
    // Unfinished Cloudflare progress saved by earlier versions still resumes after upgrading.
    expect(JSON.parse(await readFile(`${outputPath}.checkpoint.json`, 'utf8')).configHash).toBe(legacyConfigHash(config()));
  });

  it('restarts explicitly and removes progress only after successful publication', async () => {
    await expect(updateGatewayBank(config(), {
      outputPath, fetch: gateway(), now, onProgress: () => { throw new Error('Pause'); },
    })).rejects.toThrow('Pause');
    const custom = config();
    custom.protocol.temperature = 0.5;
    const fetch = gateway();
    const onResume = vi.fn();
    const result = await updateGatewayBank(custom, { outputPath, fetch, now, restart: true, onResume });
    expect(result).toMatchObject({ resumedRuns: 0, requests: 10, requestsThisRun: 10 });
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(onResume).not.toHaveBeenCalled();
    expect(await entries(directory)).toEqual(['default_bank.json']);
  });
});

describe('OpenRouter collection', () => {
  const key = openrouterCredentials.OPENROUTER_API_KEY;
  const paths = { 'chat-completions': '/chat/completions', responses: '/responses', messages: '/messages' } as const;
  let directory: string;
  let outputPath: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'logitping-bank-openrouter-'));
    outputPath = join(directory, 'default_bank.json');
    await writeFile(outputPath, 'previous-bank-bytes\n');
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  /** Answers each model's runs with constant offset + run, in the format its endpoint expects. */
  function relay() {
    const runs = new Map<string, number>();
    return vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const { model } = JSON.parse(String(init?.body)) as { model: string };
      const run = (runs.get(model) ?? 0) + 1;
      runs.set(model, run);
      const apiFormat = (Object.keys(paths) as (keyof typeof paths)[]).find((format) => String(url).endsWith(paths[format]))!;
      return formattedResponse(apiFormat, Array<number>(64).fill((model.startsWith('openai/') ? 10 : 200) + run).join(' '));
    });
  }

  const expectedProfiles = (models: GatewayTarget[]) => createFingerprintBank({
    source: 'Expected fixture', protocol: config().protocol, checkpoints: [64],
    models: models.map((model, index) => ({
      id: model.id, family: model.family,
      training: [1, 2, 3].map((n) => Array<number>(64).fill((index ? 200 : 10) + n)),
      validation: [4, 5].map((n) => Array<number>(64).fill((index ? 200 : 10) + n)),
    })),
  }).models.map((model) => model.profiles);

  it.each(['chat-completions', 'responses', 'messages'] as const)(
    'collects %s through OpenRouter with bearer auth and response caching disabled', async (apiFormat) => {
      const custom = parseGatewayBankConfig({ ...openrouterInput(), models: input().models.map((model) => ({ ...model, apiFormat })) }, openrouterCredentials);
      const fetch = relay();
      const result = await updateGatewayBank(custom, { outputPath, fetch, now });
      expect(fetch).toHaveBeenCalledTimes(10);
      for (const [url, init] of fetch.mock.calls) {
        expect(String(url)).toBe(`https://openrouter.ai/api/v1${paths[apiFormat]}`);
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe(`Bearer ${key}`);
        expect(headers.get('x-openrouter-cache')).toBe('false');
        expect(headers.has('x-api-key')).toBe(false);
        expect([...headers.keys()].filter((name) => name.startsWith('cf-aig-'))).toEqual([]);
        expect(headers.get('accept')).toBe('application/json');
        expect(init?.redirect).toBe('error');
        const body = JSON.parse(String(init?.body));
        expect(body.stream).toBe(false);
        expect(body.provider).toBeUndefined();
      }
      expect(result.bank.models.map((model) => model.profiles)).toEqual(expectedProfiles(custom.models));
      for (const [index, model] of result.bank.models.entries()) {
        expect(model.provenance).toMatch(/^OpenRouter API; collected 2026-09-23T00:00:00\.000Z; integer-v1; corpus sha256:/);
        expect(model.provenance).toContain(`; model=${custom.models[index]!.model}; api=${apiFormat}; stream=false; training=3; validation=2;`);
        expect(model.provenance).toContain(' cache=bypassed;');
      }
      expect(result.bank.calibration?.source).toMatch(/^OpenRouter API; collected 2026-09-23T00:00:00\.000Z;/);
      expect(await readFile(outputPath, 'utf8')).not.toContain(key);
      expect(await entries(directory)).toEqual(['default_bank.json']);
    },
  );

  it('routes a mixed configuration per model and records each route in provenance', async () => {
    const custom = parseGatewayBankConfig({
      ...input(), models: [input().models[0]!, { ...input().models[1]!, provider: 'openrouter', apiFormat: 'messages' }],
    }, allCredentials);
    const fetch = relay();
    const { bank } = await updateGatewayBank(custom, { outputPath, fetch, now });
    expect(fetch).toHaveBeenCalledTimes(10);
    for (const [url, init] of fetch.mock.calls) {
      const headers = new Headers(init?.headers);
      if (JSON.parse(String(init?.body)).model === 'openai/reference-a') {
        expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/${credentials.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`);
        expect(headers.get('authorization')).toBe(`Bearer ${credentials.CLOUDFLARE_API_TOKEN}`);
        expect(headers.get('cf-aig-gateway-id')).toBe(credentials.CLOUDFLARE_GATEWAY_ID);
        expect(headers.has('x-openrouter-cache')).toBe(false);
      } else {
        expect(String(url)).toBe('https://openrouter.ai/api/v1/messages');
        expect(headers.get('authorization')).toBe(`Bearer ${key}`);
        expect(headers.get('x-openrouter-cache')).toBe('false');
        expect(headers.has('cf-aig-gateway-id')).toBe(false);
      }
    }
    expect(bank.models.map((model) => model.profiles)).toEqual(expectedProfiles(custom.models));
    expect(bank.models[0]!.provenance).toMatch(/^Cloudflare AI Gateway REST; collected .*; model=openai\/reference-a; api=chat-completions;/);
    expect(bank.models[1]!.provenance).toMatch(/^OpenRouter API; collected .*; model=anthropic\/reference-b; api=messages;/);
    expect(bank.calibration?.source).toMatch(/^Cloudflare AI Gateway REST and OpenRouter API; collected /);
    const text = await readFile(outputPath, 'utf8');
    for (const credential of Object.values(allCredentials)) expect(text).not.toContain(credential);
  });

  it('rejects an OpenRouter cache hit and preserves the previous bank', async () => {
    const hit = async () => {
      const cached = response('17 '.repeat(64));
      return new Response(cached.body, { headers: { 'content-type': 'application/json', 'x-openrouter-cache-status': 'HIT' } });
    };
    const fetch = relay().mockImplementationOnce(hit);
    await expect(updateGatewayBank(openrouterConfig(), { outputPath, fetch, now }))
      .rejects.toThrow('reference-a training run 1: OpenRouter served a cached response despite cache bypass; collection stopped');
    expect(fetch).toHaveBeenCalledOnce();
    expect(await readFile(outputPath, 'utf8')).toBe('previous-bank-bytes\n');
    expect(await readdir(directory)).toEqual(['default_bank.json', 'default_bank.json.checkpoint.json']);
  });

  it('redacts the OpenRouter key from errors', async () => {
    const fetch: typeof globalThis.fetch = async () => { throw new Error(`upstream echoed ${key}`); };
    await expect(updateGatewayBank(openrouterConfig(), { outputPath, fetch, now }))
      .rejects.toThrow(/^reference-a training run 1: upstream echoed \[redacted\]$/);
  });

  it('resumes OpenRouter progress after the key rotates or unused Cloudflare settings change', async () => {
    await expect(updateGatewayBank(openrouterConfig(), {
      outputPath, fetch: relay(), now, onProgress: ({ completedRequests }) => { if (completedRequests === 3) throw new Error('Pause'); },
    })).rejects.toThrow('Pause');
    const rotated = parseGatewayBankConfig(openrouterInput(), { ...credentials, CLOUDFLARE_GATEWAY_ID: 'other-gateway', OPENROUTER_API_KEY: 'sk-or-v1-rotated' });
    const fetch = relay();
    const result = await updateGatewayBank(rotated, { outputPath, fetch, now });
    expect(result).toMatchObject({ resumedRuns: 3, requests: 10, requestsThisRun: 7 });
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer sk-or-v1-rotated');
  });
});

const referenceC = { id: 'reference-c', family: 'gpt', model: 'openai/reference-c' };
const [referenceA, referenceB] = input().models as [typeof referenceC, typeof referenceC];
const later = () => new Date('2026-09-24T00:00:00.000Z');

/** Three-model plans need a larger cap: configuration still validates the full collection. */
const withModels = (models: object[], extra: object = {}) =>
  parseGatewayBankConfig({ ...input(), maxRequests: 15, ...extra, models }, allCredentials);

/** Each route answers constant runs offset + 1, offset + 2, ..., so every model's corpus is distinct. */
function routes(samples = 64) {
  const offsets: Record<string, number> = { 'openai/reference-a': 10, 'anthropic/reference-b': 200, 'openai/reference-c': 100 };
  const runs = new Map<string, number>();
  return vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const { model } = JSON.parse(String(init?.body)) as { model: string };
    const run = (runs.get(model) ?? 0) + 1;
    runs.set(model, run);
    return response(Array<number>(samples).fill(offsets[model]! + run).join(' '));
  });
}

/** What a fresh enrollment of runs offset + 1..3 (training) and offset + 4..5 (validation) produces. */
function expectedModel(id: string, family: string, offset: number, nuisanceDirections: number[][] = []) {
  return createFingerprintBank({
    source: 'Expected fixture', protocol: config().protocol, checkpoints: [64], nuisanceDirections,
    models: [{
      id, family,
      training: [1, 2, 3].map((n) => Array<number>(64).fill(offset + n)),
      validation: [4, 5].map((n) => Array<number>(64).fill(offset + n)),
    }],
  }).models[0]!;
}

describe('Incremental bank plans', () => {
  let directory: string;
  let outputPath: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'logitping-bank-plan-'));
    outputPath = join(directory, 'default_bank.json');
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  const enrolled = async (custom = config(), samples = 64): Promise<FingerprintBank> =>
    (await updateGatewayBank(custom, { outputPath, fetch: routes(samples), now })).bank;
  const ids = (targets: GatewayTarget[]) => targets.map((target) => target.id);

  it('budgets every configured model for a full collection', () => {
    const custom = parseGatewayBankConfig({
      ...input(), maxRequests: 14, models: [referenceA, { ...referenceB, maxTokens: 1000 }],
    }, credentials);
    const plan = planGatewayBankUpdate(custom);
    expect(ids(plan.collect)).toEqual(['reference-a', 'reference-b']);
    // 5 runs at 384 tokens + 5 runs at 1000 tokens + 4 spare attempts at the largest limit.
    expect(plan).toMatchObject({ retain: [], replace: [], remove: [], requiredRuns: 10, spareRequests: 4, maxOutputTokens: 10_920 });
  });

  it('collects only configured models the bank does not enroll', async () => {
    const plan = planGatewayBankUpdate(withModels([referenceA, referenceB, referenceC]), await enrolled());
    expect(ids(plan.collect)).toEqual(['reference-c']);
    // 5 runs, and 10 spare attempts, at the 384-token default limit.
    expect(plan).toMatchObject({
      retain: ['reference-a', 'reference-b'], replace: [], remove: [], requiredRuns: 5, spareRequests: 10, maxOutputTokens: 5_760,
    });
  });

  it('plans no requests when the bank already enrolls every configured model', async () => {
    const plan = planGatewayBankUpdate(config(), await enrolled());
    expect(plan).toMatchObject({
      collect: [], retain: ['reference-a', 'reference-b'], replace: [], remove: [], requiredRuns: 0, spareRequests: 0, maxOutputTokens: 0,
    });
  });

  it('removes enrolled models the configuration no longer lists', async () => {
    const plan = planGatewayBankUpdate(withModels([referenceA, referenceC]), await enrolled());
    expect(ids(plan.collect)).toEqual(['reference-c']);
    expect(plan).toMatchObject({ retain: ['reference-a'], replace: [], remove: ['reference-b'] });
  });

  it.each([
    ['route', { model: 'openai/reference-a-2026' }],
    ['API format', { apiFormat: 'responses' }],
    ['token limit field', { tokenLimitField: 'max_completion_tokens' }],
    ['training runs', { trainingRuns: 4 }],
    ['validation runs', { validationRuns: 3 }],
    ['family', { family: 'gpt-next' }],
  ])('recollects an enrolled model whose %s changed', async (_name, change) => {
    const plan = planGatewayBankUpdate(withModels([{ ...referenceA, ...change }, referenceB]), await enrolled());
    expect(ids(plan.collect)).toEqual(['reference-a']);
    expect(plan).toMatchObject({ retain: ['reference-b'], replace: ['reference-a'], remove: [] });
  });

  it.each([
    ['uncalibrated', { status: 'uncalibrated' }],
    ['enrolled by other tooling', { provenance: 'Manual enrollment from local runs' }],
  ] as const)('recollects a model that is %s', async (_name, change) => {
    const base = await enrolled();
    Object.assign(base.models[1]!, change);
    const plan = planGatewayBankUpdate(config(), base);
    expect(ids(plan.collect)).toEqual(['reference-b']);
    expect(plan).toMatchObject({ retain: ['reference-a'], replace: ['reference-b'] });
  });

  it.each([
    ['language', { protocol: { ...input().protocol, language: 'zh' } }],
    ['temperature', { protocol: { ...input().protocol, temperature: 0.5 } }],
  ])('recollects every model when the protocol %s changed', async (_name, change) => {
    const plan = planGatewayBankUpdate(withModels(input().models, change), await enrolled());
    expect(ids(plan.collect)).toEqual(['reference-a', 'reference-b']);
    expect(plan).toMatchObject({ retain: [], replace: ['reference-a', 'reference-b'] });
  });

  it('retains an enrolled model whose token budget changed', async () => {
    const plan = planGatewayBankUpdate(withModels([{ ...referenceA, maxTokens: 8192 }, referenceB]), await enrolled());
    expect(plan).toMatchObject({ collect: [], retain: ['reference-a', 'reference-b'], replace: [], requiredRuns: 0 });
  });

  it('retains enrolled models whose provider changed and reports them', async () => {
    const base = await enrolled();
    expect(planGatewayBankUpdate(withModels(input().models, { provider: 'openrouter' }), base)).toMatchObject({
      collect: [], retain: ['reference-a', 'reference-b'], replace: [], providerChanged: ['reference-a', 'reference-b'], requiredRuns: 0,
    });
    expect(planGatewayBankUpdate(config(), base).providerChanged).toEqual([]);
    // Switching back is equally free; only models enrolled through the other provider are reported.
    const mixed = await enrolled(withModels([referenceA, { ...referenceB, provider: 'openrouter' }]));
    expect(planGatewayBankUpdate(config(), mixed)).toMatchObject({
      collect: [], retain: ['reference-a', 'reference-b'], providerChanged: ['reference-b'],
    });
  });

  it('recollects every model when calibration checkpoints changed', async () => {
    const at128 = (checkpoints: number[]) => withModels(input().models, { protocol: { ...input().protocol, targetSamples: 128 }, checkpoints });
    const base = await enrolled(at128([128]), 128);
    const plan = planGatewayBankUpdate(at128([64, 128]), base);
    expect(ids(plan.collect)).toEqual(['reference-a', 'reference-b']);
    expect(plan.retain).toEqual([]);
  });

  it('reads the existing bank for a dry run and rejects a missing or invalid one', async () => {
    const base = await enrolled();
    expect(await readIncrementalBase(outputPath)).toEqual(base);
    await writeFile(outputPath, 'previous-bank-bytes\n');
    await expect(readIncrementalBase(outputPath)).rejects.toThrow(/not valid JSON.*full update/);
    await writeFile(outputPath, '{}');
    await expect(readIncrementalBase(outputPath)).rejects.toThrow(/^Invalid bank.*full update/);
    await rm(outputPath);
    await expect(readIncrementalBase(outputPath)).rejects.toThrow(/needs an existing bank.*full update/);
    expect(await entries(directory)).toEqual([]);
  });
});

describe('Incremental bank updates', () => {
  let directory: string;
  let outputPath: string;
  let base: FingerprintBank;
  let baseText: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'logitping-bank-incremental-'));
    outputPath = join(directory, 'default_bank.json');
    base = (await updateGatewayBank(config(), { outputPath, fetch: routes(), now })).bank;
    baseText = await readFile(outputPath, 'utf8');
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('probes only new models and merges them after the enrolled models', async () => {
    const fetch = routes();
    const onPlan = vi.fn();
    const result = await updateGatewayBank(withModels([referenceA, referenceB, referenceC]), {
      outputPath, fetch, now: later, incremental: true, onPlan,
    });
    expect(onPlan).toHaveBeenCalledOnce();
    expect(onPlan.mock.calls[0]![0].collect.map((target: GatewayTarget) => target.id)).toEqual(['reference-c']);
    expect(fetch).toHaveBeenCalledTimes(5);
    for (const [, init] of fetch.mock.calls) expect(JSON.parse(String(init?.body)).model).toBe('openai/reference-c');
    expect(result).toMatchObject({ changed: true, requests: 5, requestsThisRun: 5, resumedRuns: 0 });
    const saved = await loadBank(outputPath);
    expect(saved.models.map((model) => model.id)).toEqual(['reference-a', 'reference-b', 'reference-c']);
    // Enrolled entries, including their original collection provenance, are kept byte for byte.
    expect(saved.models.slice(0, 2)).toEqual(base.models);
    const expected = expectedModel('reference-c', 'gpt', 100);
    expect(saved.models[2]).toMatchObject({ status: 'calibrated', profiles: expected.profiles, integerProbabilities: expected.integerProbabilities });
    expect(saved.models[2]!.provenance).toContain('collected 2026-09-24T00:00:00.000Z');
    expect(saved.models[2]!.provenance).toContain('model=openai/reference-c; api=chat-completions; stream=false; training=3; validation=2;');
    expect(saved.calibration).toMatchObject({ heldOutRuns: 6, sequentialValidated: false });
    expect(result.bank).toEqual(saved);
    expect(await entries(directory)).toEqual(['default_bank.json']);
  });

  it('keeps enrolled models without requests when the provider switches', async () => {
    const before = await stat(outputPath);
    const fetch = routes();
    const result = await updateGatewayBank(openrouterConfig(), { outputPath, fetch, now: later, incremental: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ changed: false, requests: 0, bank: base });
    expect((await stat(outputPath)).mtimeMs).toBe(before.mtimeMs);
  });

  it('collects only new models after switching a Cloudflare bank to OpenRouter', async () => {
    const fetch = routes();
    const result = await updateGatewayBank(withModels([referenceA, referenceB, referenceC], { provider: 'openrouter' }), {
      outputPath, fetch, now: later, incremental: true,
    });
    expect(fetch).toHaveBeenCalledTimes(5);
    for (const [url] of fetch.mock.calls) expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(result.bank.models.slice(0, 2)).toEqual(base.models);
    expect(result.bank.models[2]!.profiles).toEqual(expectedModel('reference-c', 'gpt', 100).profiles);
    expect(result.bank.models[2]!.provenance).toMatch(/^OpenRouter API; collected 2026-09-24T00:00:00\.000Z;/);
    expect(result.bank.calibration?.source).toMatch(/^Cloudflare AI Gateway REST and OpenRouter API; integer-v1; incremental update collected 1 and retained 2 models;/);
    expect(await readFile(outputPath, 'utf8')).not.toContain(openrouterCredentials.OPENROUTER_API_KEY);
  });

  it('calibrates new models with the enrolled bank nuisance directions', async () => {
    const directions = [Array<number>(FEATURE_DIMENSION).fill(1)];
    await writeFile(outputPath, JSON.stringify({ ...base, nuisanceDirections: directions }));
    await updateGatewayBank(withModels([referenceA, referenceB, referenceC]), { outputPath, fetch: routes(), now, incremental: true });
    const saved = await loadBank(outputPath);
    const expected = expectedModel('reference-c', 'gpt', 100, directions);
    expect(expected.profiles).not.toEqual(expectedModel('reference-c', 'gpt', 100).profiles);
    expect(saved.nuisanceDirections).toEqual(directions);
    expect(saved.models[2]!.profiles).toEqual(expected.profiles);
  });

  it('leaves the bank and unrelated saved progress untouched when nothing needs collecting', async () => {
    const checkpoint = `${outputPath}.checkpoint.json`;
    await writeFile(checkpoint, 'progress-from-another-collection');
    const before = await stat(outputPath);
    const fetch = routes();
    const result = await updateGatewayBank(config(), { outputPath, fetch, now: later, incremental: true });
    expect(result).toMatchObject({ changed: false, requests: 0, requestsThisRun: 0, resumedRuns: 0, bank: base });
    expect(fetch).not.toHaveBeenCalled();
    expect((await stat(outputPath)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(checkpoint, 'utf8')).toBe('progress-from-another-collection');
    expect(await entries(directory)).toEqual(['default_bank.json', 'default_bank.json.checkpoint.json']);
  });

  it('drops unconfigured models without new requests', async () => {
    const three = (await updateGatewayBank(withModels([referenceA, referenceB, referenceC]), { outputPath, fetch: routes(), now })).bank;
    const checkpoint = `${outputPath}.checkpoint.json`;
    await writeFile(checkpoint, 'progress-from-another-collection');
    const fetch = routes();
    const result = await updateGatewayBank(config(), { outputPath, fetch, now: later, incremental: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ changed: true, requests: 0 });
    const saved = await loadBank(outputPath);
    expect(saved.models).toEqual(three.models.slice(0, 2));
    expect(saved.calibration).toMatchObject({ heldOutRuns: 4, sequentialValidated: false });
    expect(await readFile(checkpoint, 'utf8')).toBe('progress-from-another-collection');
  });

  it('resumes an interrupted incremental collection and refuses to resume it as a full update', async () => {
    const custom = withModels([referenceA, referenceB, referenceC]);
    const fetch = routes();
    await expect(updateGatewayBank(custom, {
      outputPath, fetch, now: later, incremental: true,
      onProgress: ({ completedRequests }) => { if (completedRequests === 2) throw new Error('Pause after saved run'); },
    })).rejects.toThrow('Pause');
    expect(await readFile(outputPath, 'utf8')).toBe(baseText);
    const checkpoint = `${outputPath}.checkpoint.json`;
    const saved = await readFile(checkpoint, 'utf8');
    const full = routes();
    await expect(updateGatewayBank(custom, { outputPath, fetch: full, now: later })).rejects.toThrow('does not match');
    expect(full).not.toHaveBeenCalled();
    expect(await readFile(checkpoint, 'utf8')).toBe(saved);
    const onResume = vi.fn();
    const result = await updateGatewayBank(custom, { outputPath, fetch, now, incremental: true, onResume });
    expect(onResume).toHaveBeenCalledExactlyOnceWith({ checkpointPath: checkpoint, completedRequests: 2, totalRequests: 5, requestsSent: 2 });
    expect(result).toMatchObject({ changed: true, resumedRuns: 2, requests: 5, requestsThisRun: 3 });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(result.bank.models.slice(0, 2)).toEqual(base.models);
    expect(result.bank.models[2]!.profiles).toEqual(expectedModel('reference-c', 'gpt', 100).profiles);
    expect(result.bank.models[2]!.provenance).toContain('collected 2026-09-24T00:00:00.000Z');
    expect(await entries(directory)).toEqual(['default_bank.json']);
  });

  it('refuses to merge into a bank edited during collection', async () => {
    const before = await readdir(directory);
    const fetch = routes();
    fetch.mockImplementationOnce(async () => {
      await writeFile(outputPath, 'concurrent edit');
      return response('101 '.repeat(64));
    });
    await expect(updateGatewayBank(withModels([referenceA, referenceB, referenceC]), { outputPath, fetch, now, incremental: true }))
      .rejects.toThrow('Bank changed during collection');
    expect(await readFile(outputPath, 'utf8')).toBe('concurrent edit');
    // Only the base bank's corpus exists: a refused publication keeps its checkpoint, not a corpus.
    expect(await readdir(directory)).toEqual([...before, 'default_bank.json.checkpoint.json'].sort());
  });

  it.each([
    ['missing', undefined, /needs an existing bank/, []],
    ['invalid', 'previous-bank-bytes\n', /not valid JSON/, ['default_bank.json']],
  ] as const)('requires an existing valid bank before sending requests (%s)', async (_name, contents, message, files) => {
    if (contents === undefined) await rm(outputPath);
    else await writeFile(outputPath, contents);
    const fetch = routes();
    await expect(updateGatewayBank(withModels([referenceA, referenceB, referenceC]), { outputPath, fetch, now, incremental: true }))
      .rejects.toThrow(message);
    expect(fetch).not.toHaveBeenCalled();
    expect(await entries(directory)).toEqual(files);
  });
});
