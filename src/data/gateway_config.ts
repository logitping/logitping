import type { FingerprintBank } from '../core/types.js';
import { readBoundedText } from '../util/fs.js';
import { isIntegerInRange, isRecord, MAX_SAMPLES, MODEL_ID_PATTERN } from '../util/validate.js';

/** Hard cap on requests across all resumes of one collection. */
export const MAX_REQUESTS = 1_000;

/** Services that relay bank-update requests to upstream model providers. */
export type GatewayProvider = 'cloudflare' | 'openrouter';

export interface GatewayTarget {
  id: string;
  family: string;
  provider: GatewayProvider;
  /** Catalog identifier on `provider`, e.g. openai/gpt-4.1-mini. */
  model: string;
  sampleCount: number;
  trainingRuns: number;
  validationRuns: number;
  maxTokens: number;
  apiFormat: 'chat-completions' | 'responses' | 'messages';
  tokenLimitField: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
}

export interface GatewayBankConfig {
  schemaVersion: 1;
  /** Cloudflare credentials; present only when a model uses Cloudflare. */
  gateway?: { accountId: string; gatewayId: string; apiToken: string };
  /** OpenRouter credentials; present only when a model uses OpenRouter. */
  openrouter?: { apiKey: string };
  protocol: FingerprintBank['protocol'];
  checkpoints: number[];
  trainingRuns: number;
  validationRuns: number;
  timeoutMs: number;
  requestDelayMs: number;
  maxRequests: number;
  maxProbeRetries: number;
  models: GatewayTarget[];
}

function object(input: unknown, field: string): Record<string, unknown> {
  if (!isRecord(input)) throw new Error(`Invalid bank-update config: ${field} must be an object`);
  return input;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid bank-update config: ${message}`);
}

function keys(value: Record<string, unknown>, allowed: string[], field: string): void {
  // Do not print unknown keys or values: a misplaced credential must not reach logs.
  check(Object.keys(value).every((key) => allowed.includes(key)), `${field} has an unsupported field`);
}

function integer(value: unknown, min: number, max: number, field: string): number {
  check(isIntegerInRange(value, min, max), `${field} must be an integer from ${min} to ${max}`);
  return value;
}

function text(value: unknown, expression: RegExp, field: string): string {
  check(typeof value === 'string' && expression.test(value), field);
  return value;
}

/**
 * Prefer the environment over the file. Distinguish a missing value, such as a sourced but
 * unexported shell variable, from a malformed one, which is described only by length.
 */
function credential(fromEnv: string | undefined, fromFile: unknown, variable: string, field: string, expression: RegExp, requirement: string): string {
  const value = fromEnv || fromFile;
  check(value !== undefined && value !== '', `${variable} is not set in the updater's environment; export it (see .env.example) or set ${field}`);
  const detail = typeof value === 'string' ? ` (got ${value.length} characters${/\s/.test(value) ? ', including whitespace' : ''})` : '';
  check(typeof value === 'string' && expression.test(value), `${fromEnv ? variable : field} must be ${requirement}${detail}`);
  return value;
}

function isProvider(value: unknown): value is GatewayProvider {
  return value === 'cloudflare' || value === 'openrouter';
}

/** Pinned catalog routes; dynamic routers would mix models under one label. */
function route(provider: GatewayProvider, model: unknown): string {
  if (provider === 'cloudflare') {
    const value = text(model, /^(?:[a-z0-9-]+|@cf)\/[a-zA-Z0-9][a-zA-Z0-9._/-]{0,190}$/, 'model must be a Cloudflare catalog identifier');
    check(!value.startsWith('dynamic/') && !value.includes('..') && !value.endsWith('/'), 'use an explicit model, not dynamic routing');
    return value;
  }
  // author/slug with an optional variant such as :free or :thinking. Floating ~author
  // aliases and @preset routes, which can change the model or request, do not match.
  const value = text(model, /^[a-z0-9][a-z0-9._-]{0,63}\/[a-zA-Z0-9][a-zA-Z0-9._/-]{0,190}(?::[a-z0-9-]{1,32})?$/, 'model must be an OpenRouter model identifier');
  const slug = value.replace(/:[a-z0-9-]+$/, '');
  check(!slug.includes('..') && !slug.endsWith('/'), 'model must be an OpenRouter model identifier');
  check(slug !== 'openrouter/auto' && slug !== 'openrouter/free', 'use an explicit model, not an OpenRouter router');
  // The :online variant adds web search results to the probe prompt.
  check(!value.endsWith(':online'), 'OpenRouter :online variants change the probe prompt');
  return value;
}

/** Environment overrides file credentials. Returned config contains a secret; never log it. */
export function parseGatewayBankConfig(input: unknown, env: NodeJS.ProcessEnv = process.env): GatewayBankConfig {
  const root = object(input, 'root');
  keys(root, ['schemaVersion', 'provider', 'gateway', 'openrouter', 'protocol', 'checkpoints', 'trainingRuns', 'validationRuns', 'timeoutMs', 'requestDelayMs', 'maxRequests', 'maxProbeRetries', 'maxShortResponseRetries', 'models'], 'root');
  check(root.schemaVersion === 1, 'schemaVersion must be 1');
  const defaultProvider = root.provider ?? 'cloudflare';
  check(isProvider(defaultProvider), 'provider must be cloudflare or openrouter');
  const gateway = object(root.gateway ?? {}, 'gateway');
  keys(gateway, ['accountId', 'gatewayId', 'apiToken'], 'gateway');
  const openrouter = object(root.openrouter ?? {}, 'openrouter');
  keys(openrouter, ['apiKey'], 'openrouter');
  const protocol = object(root.protocol, 'protocol');
  keys(protocol, ['id', 'transport', 'language', 'targetSamples', 'temperature'], 'protocol');
  check(protocol.id === undefined || protocol.id === 'integer-v1', 'only integer-v1 is supported');
  // `openai` is the legacy label for the same mixed-format collection.
  check(protocol.transport === undefined || protocol.transport === 'api' || protocol.transport === 'openai', 'Gateway banks use the api transport label; select the wire format with model apiFormat');
  const language = protocol.language ?? 'en';
  check(language === 'en' || language === 'zh', 'language must be en or zh');
  const targetSamples = integer(protocol.targetSamples, 64, MAX_SAMPLES, 'targetSamples');
  const temperature = protocol.temperature ?? null;
  check(temperature === null || (typeof temperature === 'number' && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2), 'temperature must be null or between 0 and 2');
  const trainingRuns = integer(root.trainingRuns ?? 10, 3, 100, 'trainingRuns');
  const validationRuns = integer(root.validationRuns ?? 5, 2, 100, 'validationRuns');
  const timeoutMs = integer(root.timeoutMs ?? 120_000, 1, 600_000, 'timeoutMs');
  const requestDelayMs = integer(root.requestDelayMs ?? 1_000, 0, 60_000, 'requestDelayMs');
  const maxRequests = integer(root.maxRequests ?? 100, 5, MAX_REQUESTS, 'maxRequests');
  const legacyRetries = root.maxShortResponseRetries === undefined ? undefined
    : integer(root.maxShortResponseRetries, 0, 5, 'maxShortResponseRetries');
  const maxProbeRetries = integer(root.maxProbeRetries ?? legacyRetries ?? 0, 0, 5, 'maxProbeRetries');
  check(legacyRetries === undefined || legacyRetries === maxProbeRetries, 'maxProbeRetries and its legacy alias maxShortResponseRetries must agree');
  const checkpoints = root.checkpoints ?? [targetSamples];
  check(Array.isArray(checkpoints) && checkpoints.length > 0 && checkpoints.length <= 32, 'provide 1–32 checkpoints');
  const counts = checkpoints.map((value) => integer(value, 64, targetSamples, 'checkpoint'));
  check(counts.every((value, i) => i === 0 || value > counts[i - 1]!) && counts.at(-1) === targetSamples, 'checkpoints must be sorted, unique, and end at targetSamples');
  check(Array.isArray(root.models) && root.models.length >= 2 && root.models.length <= 32, 'provide 2–32 reference models');
  const ids = new Set<string>();
  const routes = new Set<string>();
  const models = root.models.map((value): GatewayTarget => {
    const entry = object(value, 'model');
    keys(entry, ['id', 'family', 'provider', 'model', 'sampleCount', 'trainingRuns', 'validationRuns', 'maxTokens', 'tokenLimitField', 'apiFormat'], 'model');
    const id = text(entry.id, MODEL_ID_PATTERN, 'invalid model id');
    const family = text(entry.family, /^[\x20-\x7e]{1,128}$/, 'invalid model family');
    check(family.trim().length > 0, 'model family cannot be blank');
    const provider = entry.provider ?? defaultProvider;
    check(isProvider(provider), 'model provider must be cloudflare or openrouter');
    const model = route(provider, entry.model);
    // The same catalog identifier may be enrolled once through each provider.
    check(!ids.has(id) && !routes.has(`${provider} ${model}`), 'model ids and catalog identifiers must be unique');
    ids.add(id);
    routes.add(`${provider} ${model}`);
    const sampleCount = integer(entry.sampleCount ?? targetSamples, 64, MAX_SAMPLES, 'model sampleCount');
    check(sampleCount === targetSamples, 'all model sample counts must equal protocol.targetSamples in one bank');
    const apiFormat = entry.apiFormat ?? 'chat-completions';
    check(apiFormat === 'chat-completions' || apiFormat === 'responses' || apiFormat === 'messages', 'invalid apiFormat');
    const tokenLimitField = entry.tokenLimitField ?? (apiFormat === 'responses' ? 'max_output_tokens' : 'max_tokens');
    check(tokenLimitField === 'max_tokens' || tokenLimitField === 'max_completion_tokens' || tokenLimitField === 'max_output_tokens', 'invalid tokenLimitField');
    check(apiFormat === 'responses' ? tokenLimitField === 'max_output_tokens'
      : apiFormat === 'messages' ? tokenLimitField === 'max_tokens'
        : tokenLimitField === 'max_tokens' || tokenLimitField === 'max_completion_tokens', 'tokenLimitField must match apiFormat');
    return {
      id, family, provider, model, sampleCount, apiFormat, tokenLimitField,
      trainingRuns: integer(entry.trainingRuns ?? trainingRuns, 3, 100, 'model trainingRuns'),
      validationRuns: integer(entry.validationRuns ?? validationRuns, 2, 100, 'model validationRuns'),
      maxTokens: integer(entry.maxTokens ?? sampleCount * 5 + 64, sampleCount, 262_144, 'model maxTokens'),
    };
  });
  const plannedRequests = models.reduce((sum, model) => sum + model.trainingRuns + model.validationRuns, 0);
  check(plannedRequests <= maxRequests, `planned runs exceed maxRequests: ${plannedRequests} required, limit ${maxRequests}`);
  // Require and validate only the credentials of providers in use.
  const uses = (provider: GatewayProvider) => models.some((target) => target.provider === provider);
  const cloudflare = uses('cloudflare') ? {
    accountId: credential(env.CLOUDFLARE_ACCOUNT_ID, gateway.accountId, 'CLOUDFLARE_ACCOUNT_ID', 'gateway.accountId', /^[a-fA-F0-9]{32}$/, 'a 32-character hexadecimal account ID'),
    gatewayId: credential(env.CLOUDFLARE_GATEWAY_ID || env.CLOUDFLARE_GATEWAY_NAME, gateway.gatewayId, 'CLOUDFLARE_GATEWAY_ID (or CLOUDFLARE_GATEWAY_NAME)', 'gateway.gatewayId', /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, 'a gateway ID of up to 64 letters, digits, hyphens, or underscores'),
    apiToken: credential(env.CLOUDFLARE_API_TOKEN, gateway.apiToken, 'CLOUDFLARE_API_TOKEN', 'gateway.apiToken', /^[\x21-\x7e]{1,4096}$/, 'a nonempty token without whitespace'),
  } : undefined;
  const apiKey = uses('openrouter')
    ? credential(env.OPENROUTER_API_KEY, openrouter.apiKey, 'OPENROUTER_API_KEY', 'openrouter.apiKey', /^[\x21-\x7e]{1,4096}$/, 'a nonempty key without whitespace')
    : undefined;
  return {
    schemaVersion: 1,
    ...(cloudflare ? { gateway: cloudflare } : {}),
    ...(apiKey ? { openrouter: { apiKey } } : {}),
    // Models may use different wire formats; the bank calibrates any HTTP API probe.
    protocol: { id: 'integer-v1', language, targetSamples, temperature, transport: 'api' },
    checkpoints: counts, trainingRuns, validationRuns, timeoutMs, requestDelayMs, maxRequests, maxProbeRetries, models,
  };
}

export async function loadGatewayBankConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<GatewayBankConfig> {
  const content = await readBoundedText(path, 1_048_576, 'Bank-update config must be a JSON file no larger than 1 MiB');
  let input: unknown;
  try { input = JSON.parse(content); } catch { throw new Error('Bank-update config is not valid JSON'); }
  return parseGatewayBankConfig(input, env);
}
