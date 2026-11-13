import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pooledBank } from '../src/data/bank_loader.js';
import { loadGatewayBankConfig, parseGatewayBankConfig } from '../src/data/gateway_config.js';
import { enrolledAs } from '../src/data/gateway_plan.js';
import { updateGatewayBank } from '../src/data/gateway_update.js';
import { refitPooledBank, type PooledCollection } from '../src/data/pooled_refit.js';

const keys = { OPENAI_API_KEY: 'sk-test-openai-credential', OPENROUTER_API_KEY: 'sk-or-test-credential', GEMINI_API_KEY: 'test-gemini-credential' };
const settings = {
  schemaVersion: 1, protocol: { language: 'en', targetSamples: 64, temperature: null }, checkpoints: [64],
  trainingRuns: 3, validationRuns: 2, timeoutMs: 500, requestDelayMs: 0, maxRequests: 15,
};
const now = () => new Date('2026-11-06T00:00:00.000Z');

// The same id on its old OpenRouter route and its new OpenAI ID, with different runs, so a wrong pick shows.
const oldGpt = { id: 'gpt-a', family: 'gpt', provider: 'openrouter', model: 'openai/gpt-a' };
const newGpt = { id: 'gpt-a', family: 'gpt', provider: 'openai', model: 'gpt-a' };
const addedGpt = { id: 'gpt-c', family: 'gpt', provider: 'openai', model: 'gpt-c' };
const claude = { id: 'claude-b', family: 'claude', provider: 'openrouter', model: 'anthropic/claude-b' };
const OFFSETS: Record<string, number> = { 'openai/gpt-a': 10, 'anthropic/claude-b': 200, 'gpt-a': 300, 'gpt-c': 100 };
const steppedRun = (first: number) => Array.from({ length: 64 }, (_, index) => (first - 1 + index * 7) % 355 + 1);

const pooledConfig = () => parseGatewayBankConfig({ ...settings, models: [newGpt, addedGpt, claude], scoring: 'pooled-sets-v1', requestsPerProbe: 2 }, keys);

/** Answers each route's runs offset + 1, offset + 2, ..., as a complete Chat Completions reply. */
function provider() {
  const runs = new Map<string, number>();
  return vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const { model } = JSON.parse(String(init?.body)) as { model: string };
    const run = (runs.get(model) ?? 0) + 1;
    runs.set(model, run);
    const content = steppedRun(OFFSETS[model]! + run).join(' ');
    return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  });
}

describe('pooled refit from several collections', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'logitping-pooled-refit-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  async function collect(name: string, models: object[], overrides: object = {}): Promise<PooledCollection> {
    const config = parseGatewayBankConfig({ ...settings, ...overrides, models }, keys);
    const result = await updateGatewayBank(config, { outputPath: join(directory, `${name}.json`), fetch: provider(), now });
    return { bank: result.bank, corpus: JSON.parse(await readFile(result.corpusPath!, 'utf8')) as PooledCollection['corpus'] };
  }
  const collections = async () => ({ old: await collect('old', [oldGpt, claude]), fresh: await collect('fresh', [newGpt, addedGpt]) });

  it('fits the same scoring as one collection of the same runs, using the new runs of a moved model', async () => {
    const { old, fresh } = await collections();
    const refit = refitPooledBank(pooledConfig(), [fresh, old]);
    const single = (await updateGatewayBank(pooledConfig(), { outputPath: join(directory, 'single.json'), fetch: provider(), now })).bank;
    expect(refit).toMatchObject({ schemaVersion: 2, protocol: { targetSamples: 64, requestsPerProbe: 2, scoring: 'pooled-sets-v1', transport: 'api' } });
    expect(refit.models.map((model) => model.id)).toEqual(['gpt-a', 'gpt-c', 'claude-b']);
    expect(refit.pooled).toEqual(single.pooled);
    expect(refit.models.map((model) => [model.profiles, model.integerProbabilities])).toEqual(single.models.map((model) => [model.profiles, model.integerProbabilities]));
    expect(refit.pooled).not.toEqual(refitPooledBank(parseGatewayBankConfig({ ...settings, models: [oldGpt, claude], scoring: 'pooled-sets-v1', requestsPerProbe: 2 }, keys), [old]).pooled);
  });

  it('combines one-model collections into the same scoring as one collection of the same runs', async () => {
    const old = await collect('old', [oldGpt, claude]);
    const refit = refitPooledBank(pooledConfig(), [await collect('gpt-a', [newGpt]), await collect('gpt-c', [addedGpt]), old]);
    const single = (await updateGatewayBank(pooledConfig(), { outputPath: join(directory, 'single.json'), fetch: provider(), now })).bank;
    expect(refit.models.map((model) => model.id)).toEqual(['gpt-a', 'gpt-c', 'claude-b']);
    expect(refit.pooled).toEqual(single.pooled);
    expect(refit.models.map((model) => [model.profiles, model.integerProbabilities])).toEqual(single.models.map((model) => [model.profiles, model.integerProbabilities]));
    expect(refit.calibration?.source).toMatch(/; pooled refit of 3 collections without new requests;/);
  });

  it('keeps each reused model and its collection provenance unchanged', async () => {
    const { old, fresh } = await collections();
    const refit = refitPooledBank(pooledConfig(), [fresh, old]);
    expect(refit.models[2]).toEqual(old.bank.models[1]);
    expect(refit.models[2]!.provenance).toMatch(/^OpenRouter API; /);
    expect(refit.models[0]).toEqual(fresh.bank.models[0]);
    expect(refit.models[0]!.provenance).toMatch(/^OpenAI API; .*; model=gpt-a; /);
    expect(refit.calibration).toEqual({
      source: expect.stringMatching(/^OpenRouter API and OpenAI API; integer-v1; pooled refit of 2 collections without new requests;/) as string,
      heldOutRuns: 6, sequentialValidated: false,
    });
  });

  it('chooses each model by its configured route, not by the order of the collections', async () => {
    const { old, fresh } = await collections();
    expect(refitPooledBank(pooledConfig(), [old, fresh])).toEqual(refitPooledBank(pooledConfig(), [fresh, old]));
  });

  it('refuses a configured model that only an earlier route or no collection enrolls', async () => {
    const { old, fresh } = await collections();
    expect(() => refitPooledBank(pooledConfig(), [old])).toThrow('gpt-a: no collection enrolls its configured route and settings');
    expect(() => refitPooledBank(pooledConfig(), [fresh])).toThrow('claude-b: no collection enrolls its configured route and settings');
  });

  it('refuses a model that two collections enroll, rather than picking one', async () => {
    const { old, fresh } = await collections();
    const again = await collect('again', [newGpt, addedGpt]);
    expect(() => refitPooledBank(pooledConfig(), [fresh, again, old])).toThrow('gpt-a: 2 collections enroll its configured route and settings');
  });

  it('refuses a corpus other than the one recorded in the provenance', async () => {
    const { old, fresh } = await collections();
    const edited = fresh.corpus.models.map((model, index) => index ? model : { ...model, training: [steppedRun(9), ...model.training.slice(1)] });
    for (const corpus of [{ ...fresh.corpus, models: edited }, old.corpus]) {
      expect(() => refitPooledBank(pooledConfig(), [{ bank: fresh.bank, corpus }, old])).toThrow('gpt-a was not fitted from its collection\'s corpus');
    }
  });

  it('refuses a collection under another protocol even when its route and settings match', async () => {
    const { fresh } = await collections();
    const chinese = await collect('chinese', [oldGpt, claude], { protocol: { ...settings.protocol, language: 'zh' } });
    expect(() => refitPooledBank(pooledConfig(), [fresh, chinese])).toThrow('A collection\'s protocol differs from the configuration');
  });

  it.each<[string, object]>([
    ['alpha', { alpha: 0.25 }],
    ['nuisance directions', { nuisanceDirections: [[1]] }],
  ])('refuses collections fitted with different %s', async (_name, change) => {
    const { old, fresh } = await collections();
    expect(() => refitPooledBank(pooledConfig(), [{ ...fresh, bank: { ...fresh.bank, ...change } }, old])).toThrow('Collections were fitted with different settings');
  });

  it('refuses a configuration without pooled scoring', async () => {
    const { old, fresh } = await collections();
    const plain = parseGatewayBankConfig({ ...settings, models: [newGpt, addedGpt, claude] }, keys);
    expect(() => refitPooledBank(plain, [fresh, old])).toThrow('Pooled refit needs a configuration with pooled scoring');
  });

  it('refuses an already pooled bank as a collection', async () => {
    const { old, fresh } = await collections();
    const pooled = refitPooledBank(pooledConfig(), [fresh, old]);
    expect(() => refitPooledBank(pooledConfig(), [{ ...fresh, bank: pooled }, old])).toThrow('Pooled refit needs banks of schema version 1');
  });
});

describe('checked-in OpenAI collection for the pooled bank', () => {
  it('collects exactly the pooled configuration\'s OpenAI models, with no other provider\'s key', async () => {
    // Only an OpenAI key is supplied: a model on any other provider would fail this load.
    const collection = await loadGatewayBankConfig('config/pooled-openai-collection.json', { OPENAI_API_KEY: keys.OPENAI_API_KEY });
    const pooled = await loadGatewayBankConfig('config/pooled-bank-update.json', keys);
    expect(collection.models.length).toBeGreaterThan(0);
    expect(collection.models).toEqual(pooled.models.filter((model) => model.provider === 'openai'));
    expect(collection.protocol).toEqual(pooled.protocol);
    expect(collection.checkpoints).toEqual(pooled.checkpoints);
    // Without scoring the updater writes the v1 bank that a refit combines.
    expect(collection).not.toHaveProperty('scoring');
  });
});

describe('checked-in pooled configuration', () => {
  it('lists every bundled model first, in bank order, with the route and settings its stored collection records', async () => {
    // Otherwise a refit that adds a new collection could not find a bundled model, or would fit another order.
    const pooled = await loadGatewayBankConfig('config/pooled-bank-update.json', keys);
    const bank = await pooledBank();
    const listed = pooled.models.slice(0, bank.models.length);
    expect(listed.map((target) => target.id)).toEqual(bank.models.map((model) => model.id));
    for (const [index, model] of bank.models.entries()) expect(enrolledAs(model, listed[index]!, pooled.checkpoints), model.id).toBe(true);
  });
});

describe('checked-in collection of gemini-4-hydrogen for the pooled bank', () => {
  it('requests only that model, exactly as the pooled configuration does, with no other provider\'s key', async () => {
    // Only a Gemini key is supplied: a model on any other provider would fail this load.
    const collection = await loadGatewayBankConfig('config/pooled-gemini-hydrogen-collection.json', { GEMINI_API_KEY: keys.GEMINI_API_KEY });
    const pooled = await loadGatewayBankConfig('config/pooled-bank-update.json', keys);
    expect(collection.models.map((model) => model.id)).toEqual(['gemini-4-hydrogen']);
    expect(collection.models).toEqual(pooled.models.filter((model) => model.id === 'gemini-4-hydrogen'));
    // The pooled fit depends on model order, and this collection is combined last.
    expect(pooled.models.at(-1)?.id).toBe('gemini-4-hydrogen');
    expect(collection.protocol).toEqual(pooled.protocol);
    expect(collection.checkpoints).toEqual(pooled.checkpoints);
    expect(collection).not.toHaveProperty('scoring');
  });
});

describe('checked-in collection of the Fable 5.2 and Gemini models for the pooled bank', () => {
  it('requests those models exactly as the pooled configuration does', async () => {
    const collection = await loadGatewayBankConfig('config/pooled-fable-gemini-collection.json', keys);
    const pooled = await loadGatewayBankConfig('config/pooled-bank-update.json', keys);
    const ids = collection.models.map((model) => model.id);
    expect(ids).toEqual(['claude-fable-5.2', 'gemini-3.8-flash', 'gemini-4-argon', 'gemini-4-carbon']);
    expect(collection.models).toEqual(pooled.models.filter((model) => ids.includes(model.id)));
    expect(collection.protocol).toEqual(pooled.protocol);
    expect(collection.checkpoints).toEqual(pooled.checkpoints);
    expect(collection).not.toHaveProperty('scoring');
  });
});
