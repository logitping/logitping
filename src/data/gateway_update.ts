import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpClient } from '../core/client.js';
import type { FingerprintBank } from '../core/types.js';
import { IntegerOutputError, IntegerStreamParser } from '../probes/integer_stream.js';
import { integerPrompt } from '../probes/templates.js';
import { errorCode, syncDirectory } from '../util/fs.js';
import { MAX_PAYLOAD_BYTES } from '../util/validate.js';
import { loadBank, validateBank } from './bank_loader.js';
import { createFingerprintBank, VARIANCE_METHOD } from './enrollment.js';
import { completedRuns, newGatewayCheckpoint, readGatewayCheckpoint, saveGatewayCheckpoint, type GatewayCheckpoint } from './gateway_checkpoint.js';
import { parseGatewayBankConfig, type GatewayBankConfig, type GatewayTarget } from './gateway_config.js';
import { collectionSettings, enrolledProvider, parseIncrementalBase, planGatewayBankUpdate, PROVIDER_LABELS, providerLabel, type BankUpdatePlan } from './gateway_plan.js';

export interface BankUpdateProgress {
  modelId: string;
  phase: 'training' | 'validation';
  run: number;
  runs: number;
  completedRequests: number;
  totalRequests: number;
  requestsSent: number;
}

export interface BankUpdateRetry {
  modelId: string;
  phase: 'training' | 'validation';
  run: number;
  attempt: number;
  maxAttempts: number;
  reason: 'short' | 'invalid';
  message: string;
  receivedSamples?: number;
  invalidPosition?: number;
  expectedSamples: number;
  requestsSent: number;
}

export interface BankUpdateOptions {
  outputPath: string;
  /** Discard the saved collection and start a new request budget. Defaults to automatic resume. */
  restart?: boolean;
  /**
   * Probe only configured models the existing bank at `outputPath` does not enroll with the
   * configured settings, and merge them into that bank. Unconfigured models are dropped.
   */
  incremental?: boolean;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  onProgress?: (progress: BankUpdateProgress) => void;
  onRetry?: (retry: BankUpdateRetry) => void;
  onResume?: (resume: BankUpdateResume) => void;
  /** Called once, under the output lock and before any request. */
  onPlan?: (plan: BankUpdatePlan) => void;
}

export interface BankUpdateResume {
  checkpointPath: string;
  completedRequests: number;
  totalRequests: number;
  requestsSent: number;
}

export interface BankUpdateResult {
  changed: boolean;
  outputPath: string;
  /** Raw samples behind newly collected models, kept so the bank can be refit without new requests. */
  corpusPath?: string;
  /** Cumulative attempts across this collection, including earlier invocations. */
  requests: number;
  requestsThisRun: number;
  resumedRuns: number;
  bank: FingerprintBank;
}

/** A message composed only of this module's text and already-redacted foreign text. */
class RedactedError extends Error {}

function safeError(error: unknown, config: GatewayBankConfig): string {
  if (!(error instanceof Error)) return 'Unexpected bank update failure';
  let message = error.message;
  // Probe errors contain only counts and positions; never mangle them or wrapped context.
  if (!(error instanceof RedactedError || error instanceof ShortProbeError || error instanceof IntegerOutputError)) {
    for (const secret of [config.gateway?.apiToken, config.gateway?.accountId, config.openrouter?.apiKey]) {
      if (secret) message = message.replaceAll(secret, '[redacted]');
    }
    if (config.gateway) {
      // Gateway names are private but may be ordinary words; redact only whole identifiers.
      const gateway = config.gateway.gatewayId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      message = message.replace(new RegExp(`(?<![A-Za-z0-9_-])${gateway}(?![A-Za-z0-9_-])`, 'g'), '[redacted]');
    }
  }
  return message.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 1_000);
}

async function readExisting(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (errorCode(error) === 'ENOENT') return undefined; throw error; }
}

class ShortProbeError extends Error {
  constructor(readonly received: number, expected: number) {
    super(`Incomplete probe: received ${received} of ${expected} integers`);
  }
}

interface Relay {
  name: string;
  baseURL: string;
  headers: Record<string, string>;
  /** Response header reporting whether the relay answered from its cache. */
  cacheStatus: string;
}

/** Endpoint, authentication, and cache bypass for the provider relaying `target`. */
function relay(config: GatewayBankConfig, target: GatewayTarget): Relay {
  if (target.provider === 'openrouter') {
    return {
      name: 'OpenRouter',
      baseURL: 'https://openrouter.ai/api/v1',
      headers: {
        // OpenRouter accepts Bearer auth on every endpoint, including Messages.
        'Authorization': `Bearer ${config.openrouter!.apiKey}`,
        // Response caching is opt-in per request or preset; this also overrides presets.
        'X-OpenRouter-Cache': 'false',
      },
      cacheStatus: 'x-openrouter-cache-status',
    };
  }
  const gateway = config.gateway!;
  return {
    name: 'Cloudflare AI Gateway',
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${gateway.accountId}/ai/v1`,
    headers: {
      // Cloudflare REST always uses Bearer auth, including its Messages endpoint.
      'Authorization': `Bearer ${gateway.apiToken}`,
      'cf-aig-gateway-id': gateway.gatewayId,
      'cf-aig-skip-cache': 'true',
      'cf-aig-max-attempts': '1',
    },
    cacheStatus: 'cf-aig-cache-status',
  };
}

async function collectRun(config: GatewayBankConfig, target: GatewayTarget, options: BankUpdateOptions): Promise<number[]> {
  const { name, baseURL, headers, cacheStatus } = relay(config, target);
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const response = await (options.fetch ?? globalThis.fetch)(url, init);
    const cache = response.headers.get(cacheStatus)?.trim().toUpperCase();
    if (cache === 'HIT' || cache === 'STALE') {
      await response.body?.cancel();
      throw new Error(`${name} served a cached response despite cache bypass; collection stopped`);
    }
    return response;
  };
  const client = new HttpClient({
    provider: target.apiFormat === 'messages' ? 'anthropic' : 'openai',
    ...(target.apiFormat === 'messages' ? {} : { apiFormat: target.apiFormat }),
    baseURL,
    model: target.model,
    tokenLimitField: target.tokenLimitField,
    headers,
    fetch,
  });
  const parser = new IntegerStreamParser();
  const samples: number[] = [];
  const accept = (sample: number) => {
    // Match the engine's fixed prefix: surplus integers must not affect calibration.
    if (samples.length < target.sampleCount) samples.push(sample);
  };
  // Collection never consults the current bank or stops on a classification result.
  // Request a complete JSON response and validate all output, including the suffix,
  // so malformed or truncated responses cannot enter the bank.
  const text = await client.complete({
    prompt: integerPrompt(target.sampleCount, config.protocol.language),
    maxTokens: target.maxTokens, timeoutMs: config.timeoutMs,
    ...(config.protocol.temperature !== null ? { temperature: config.protocol.temperature } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  for (const sample of parser.push(text)) accept(sample);
  for (const sample of parser.finish()) accept(sample);
  if (samples.length !== target.sampleCount) throw new ShortProbeError(samples.length, target.sampleCount);
  return samples;
}

interface Collection {
  state: GatewayCheckpoint;
  resumedRuns: number;
  initialRequests: number;
}

/** Collect every run of `config.models`, resuming from and saving to `checkpointPath`. */
async function collectProbes(config: GatewayBankConfig, checkpointPath: string, options: BankUpdateOptions): Promise<Collection> {
  const saved = options.restart ? undefined : await readGatewayCheckpoint(checkpointPath, config);
  const state = saved ?? newGatewayCheckpoint(config, (options.now?.() ?? new Date()).toISOString());
  // Replacing a checkpoint requires an explicit restart and the same output lock.
  // Do not remove it first: a failed write must leave the previous progress intact.
  if (!saved) await saveGatewayCheckpoint(checkpointPath, state);
  const { models, shortResponses, invalidResponses } = state;
  const totalRequests = config.models.reduce((sum, model) => sum + model.trainingRuns + model.validationRuns, 0);
  let completedRequests = completedRuns(state);
  const resumedRuns = completedRequests;
  const initialRequests = state.requestsSent;
  if (saved) options.onResume?.({ checkpointPath, completedRequests, totalRequests, requestsSent: state.requestsSent });
  if (state.requestsSent + totalRequests - completedRequests > config.maxRequests) {
    throw new Error(`Saved request budget cannot cover the unfinished runs within maxRequests=${config.maxRequests}; increase maxRequests to resume`);
  }
  // Alternate models within each phase so provider drift is less coupled to model order.
  // Validation always consists of new, separately requested responses after training.
  for (const phase of ['training', 'validation'] as const) {
    const countKey = phase === 'training' ? 'trainingRuns' : 'validationRuns';
    const rounds = Math.max(...config.models.map((model) => model[countKey]));
    for (let round = 0; round < rounds; round++) {
      for (const [index, target] of config.models.entries()) {
        if (round >= target[countKey] || round < models[index]![phase].length) continue;
        try {
          for (let attempt = 0; ; attempt++) {
            if (state.requestsSent && config.requestDelayMs) {
              await delay(config.requestDelayMs, undefined, options.signal ? { signal: options.signal } : {});
            }
            options.signal?.throwIfAborted();
            if (state.requestsSent >= config.maxRequests) throw new Error('Request budget exhausted; maxRequests reached');
            // Reserve the attempt durably before sending it. An interrupted or
            // uncertain request still counts against the collection's total cap.
            state.requestsSent++;
            await saveGatewayCheckpoint(checkpointPath, state);
            try {
              models[index]![phase].push(await collectRun(config, target, options));
              // Persist before progress callbacks, cancellation, or the next paid call.
              await saveGatewayCheckpoint(checkpointPath, state);
              break;
            } catch (error) {
              if (!(error instanceof ShortProbeError) && !(error instanceof IntegerOutputError)) throw error;
              const short = error instanceof ShortProbeError;
              (short ? shortResponses : invalidResponses)[index]![phase]++;
              await saveGatewayCheckpoint(checkpointPath, state);
              if (attempt >= config.maxProbeRetries) {
                throw new Error(`${error.message}; probe retry limit reached (maxProbeRetries=${config.maxProbeRetries})`);
              }
              // Reserve one request for each unfinished run, including this one.
              // Fail now if retrying cannot leave enough budget to finish the bank.
              if (state.requestsSent + totalRequests - completedRequests > config.maxRequests) {
                throw new Error(`${error.message}; no retry budget remains within maxRequests=${config.maxRequests}; increase maxRequests to allow additional attempts`);
              }
              options.signal?.throwIfAborted();
              options.onRetry?.({
                modelId: target.id, phase, run: round + 1, attempt: attempt + 2,
                maxAttempts: config.maxProbeRetries + 1, reason: short ? 'short' : 'invalid',
                message: safeError(error, config),
                ...(short ? { receivedSamples: error.received } : { invalidPosition: error.position }),
                expectedSamples: target.sampleCount, requestsSent: state.requestsSent,
              });
            }
          }
        }
        catch (error) { throw new RedactedError(`${target.id} ${phase} run ${round + 1}: ${safeError(error, config)}`); }
        completedRequests++;
        options.onProgress?.({ modelId: target.id, phase, run: round + 1, runs: target[countKey], completedRequests, totalRequests, requestsSent: state.requestsSent });
      }
    }
  }
  return { state, resumedRuns, initialRequests };
}

/** The corpus a collection's provenance names: protocol, checkpoints, and every accepted run. */
function corpus(config: GatewayBankConfig, state: GatewayCheckpoint) {
  const content = { protocol: config.protocol, checkpoints: config.checkpoints, models: state.models };
  return { content, digest: createHash('sha256').update(JSON.stringify(content)).digest('hex') };
}

/** Calibrate the collected `config.models`, recording each model's collection in its provenance. */
function enroll(config: GatewayBankConfig, state: GatewayCheckpoint, nuisanceDirections?: number[][]): FingerprintBank {
  const { collectedAt, models, shortResponses, invalidResponses } = state;
  const { digest } = corpus(config, state);
  const details = `collected ${collectedAt}; integer-v1; corpus sha256:${digest}; labels are requested catalog identities, not independent model attestation`;
  const bank = createFingerprintBank({
    source: `${providerLabel(config.models.map((target) => target.provider))}; ${details}`, protocol: config.protocol, checkpoints: config.checkpoints, models,
    ...(nuisanceDirections ? { nuisanceDirections } : {}),
  });
  for (const [index, model] of bank.models.entries()) {
    const target = config.models[index]!;
    const rejected = shortResponses[index]!;
    const invalid = invalidResponses[index]!;
    model.provenance = `${PROVIDER_LABELS[target.provider]}; ${details}${collectionSettings(target)} cache=bypassed; variance=${VARIANCE_METHOD}; retries=${rejected.training + rejected.validation + invalid.training + invalid.validation}; short-training-responses=${rejected.training}; short-validation-responses=${rejected.validation}; invalid-training-responses=${invalid.training}; invalid-validation-responses=${invalid.validation}; maxProbeRetries=${config.maxProbeRetries}`;
  }
  return bank;
}

/** Keep retained models verbatim, add newly collected ones, and follow configuration order. */
function merge(config: GatewayBankConfig, plan: BankUpdatePlan, base: FingerprintBank, collected?: FingerprintBank): FingerprintBank {
  const enrolled = new Map([...base.models, ...(collected?.models ?? [])].map((model) => [model.id, model]));
  const models = config.models.map((target) => enrolled.get(target.id)!);
  return validateBank({
    ...base, protocol: config.protocol, models,
    calibration: {
      // Retained models may have been collected through a provider other than the configured one.
      source: `${providerLabel(models.map(enrolledProvider))}; integer-v1; incremental update collected ${plan.collect.length} and retained ${plan.retain.length} models; each model's provenance records its collection; labels are requested catalog identities, not independent model attestation`,
      // Retained provenance matched the configured run counts, including held-out runs.
      heldOutRuns: config.models.reduce((sum, target) => sum + target.validationRuns, 0),
      sequentialValidated: false,
    },
  });
}

/** Resume saved probes, then publish an all-or-nothing bank refresh. */
export async function updateGatewayBank(input: GatewayBankConfig, options: BankUpdateOptions): Promise<BankUpdateResult> {
  // Revalidate callers from JavaScript as well as JSON; do not reread environment secrets.
  const config = parseGatewayBankConfig(input, {});
  const outputPath = resolve(options.outputPath);
  const lockPath = `${outputPath}.lock`;
  const checkpointPath = `${outputPath}.checkpoint.json`;
  const tempPath = `${outputPath}.${randomUUID()}.tmp`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    options.signal?.throwIfAborted();
    await mkdir(dirname(outputPath), { recursive: true });
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (errorCode(error) === 'EEXIST') throw new Error('Another bank update holds the output lock; verify no updater is running before removing a stale .lock file');
      throw error;
    }
    await lock.writeFile(`${process.pid}\n`);
    const before = await readExisting(outputPath);
    const base = options.incremental ? parseIncrementalBase(before) : undefined;
    const plan = planGatewayBankUpdate(config, base);
    options.onPlan?.(plan);
    // Saved progress, if any, belongs to another collection; leave it for that one.
    if (base && !plan.collect.length && !plan.remove.length) {
      return { changed: false, outputPath, requests: 0, requestsThisRun: 0, resumedRuns: 0, bank: base };
    }
    // The checkpoint covers only the models this update collects.
    const targets = { ...config, models: plan.collect };
    const collection = plan.collect.length ? await collectProbes(targets, checkpointPath, options) : undefined;
    options.signal?.throwIfAborted();
    const collected = collection && enroll(targets, collection.state, base?.nuisanceDirections);
    const bank = base ? merge(config, plan, base, collected) : collected!;
    // Enrollment calibrates distance envelopes, not a sequential error-rate guarantee.
    const serialized = `${JSON.stringify(bank, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_PAYLOAD_BYTES) throw new Error('Generated bank exceeds the 16 MiB bank limit');
    const changed = serialized !== before;
    if (changed) {
      const temporary = await open(tempPath, 'wx', 0o644);
      try { await temporary.writeFile(serialized); await temporary.sync(); }
      finally { await temporary.close(); }
      await loadBank(tempPath);
      options.signal?.throwIfAborted();
      if (await readExisting(outputPath) !== before) throw new Error('Bank changed during collection; refusing to overwrite another edit');
    }
    let corpusPath: string | undefined;
    if (collection) {
      // Keep the accepted runs, written before publishing: refitting the bank needs no new requests.
      // Hashing `content` reproduces the corpus sha256 recorded in each collected model's provenance.
      const { content, digest } = corpus(targets, collection.state);
      corpusPath = `${outputPath}.corpus-${digest}.json`;
      await writeFile(corpusPath, `${JSON.stringify({ schemaVersion: 1, collectedAt: collection.state.collectedAt, ...content })}\n`);
    }
    if (changed) {
      await rename(tempPath, outputPath);
      await syncDirectory(dirname(outputPath));
    }
    // Keep the complete corpus if calibration or publication fails; retrying then
    // needs no API calls. A published collection starts fresh on the next invocation.
    if (collection) await rm(checkpointPath, { force: true });
    const requests = collection?.state.requestsSent ?? 0;
    return {
      changed, outputPath, ...(corpusPath ? { corpusPath } : {}), requests, requestsThisRun: requests - (collection?.initialRequests ?? 0),
      resumedRuns: collection?.resumedRuns ?? 0, bank,
    };
  } catch (error) {
    throw new Error(safeError(error, config));
  } finally {
    await rm(tempPath, { force: true });
    if (lock) {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}
