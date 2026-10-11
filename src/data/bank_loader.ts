import defaults from './default_bank.json';
import { LogitpingError } from '../core/errors.js';
import type { FingerprintBank } from '../core/types.js';
import { assertDistribution } from '../math/hellinger.js';
import { FEATURE_DIMENSION, FEATURE_VERSION, INTEGER_MAX } from '../math/ordered_block.js';
import { FAMILY_SIZES, POOLED_SCORING } from '../math/pooled_features.js';
import { MIN_SEQUENTIAL_SAMPLES } from '../math/sprt.js';
import { readBoundedText } from '../util/fs.js';
import { isIntegerInRange as integer, isRecord, MAX_PAYLOAD_BYTES, MAX_SAMPLES, MIN_SAMPLES, MODEL_ID_PATTERN } from '../util/validate.js';

export const BANK_TRANSPORTS: readonly FingerprintBank['protocol']['transport'][] = ['api', 'openai', 'anthropic', 'claude', 'codex'];

const invalidBank = (message: string) => new LogitpingError('INVALID_BANK', message);

function object(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidBank(`Invalid bank: ${field} must be an object`);
  return value;
}

function check(condition: unknown, field: string): asserts condition {
  if (!condition) throw invalidBank(`Invalid bank: ${field}`);
}

/** assertDistribution's RangeError would not name the bank as the problem. */
function distribution(values: readonly number[], field: string): void {
  try { assertDistribution(values); } catch { throw invalidBank(`Invalid bank: ${field} must be nonnegative and sum to one`); }
}

function vector(value: unknown, size: number, field: string): asserts value is number[] {
  check(Array.isArray(value) && value.length === size && value.every((x) => typeof x === 'number' && Number.isFinite(x)), field);
}

function validatePooled(bank: Record<string, unknown>, protocol: Record<string, unknown>, models: Record<string, unknown>[]): void {
  check(protocol.scoring === POOLED_SCORING, `protocol.scoring must be ${POOLED_SCORING}`);
  check(integer(protocol.requestsPerProbe, 2, 64), 'requestsPerProbe must be an integer from 2 to 64');
  check((protocol.targetSamples as number) * protocol.requestsPerProbe <= MAX_SAMPLES, `targetSamples × requestsPerProbe must be at most ${MAX_SAMPLES}`);
  check(models.length >= 2 && models.every((model) => model.status === 'calibrated'), 'pooled banks need at least two calibrated models');
  const pooled = object(bank.pooled, 'pooled');
  check(typeof pooled.alpha === 'number' && pooled.alpha > 0 && pooled.alpha < 1, 'pooled alpha');
  const bootstrap = object(pooled.bootstrap, 'pooled.bootstrap');
  check(integer(bootstrap.draws, 100, 100_000) && integer(bootstrap.seed, 0, 0xffffffff), 'pooled bootstrap');
  check(Array.isArray(pooled.models) && pooled.models.length === models.length, 'pooled.models must match models');
  for (const value of pooled.models) {
    const entry = object(value, 'pooled model');
    check(Array.isArray(entry.families) && entry.families.length === FAMILY_SIZES.length, 'pooled feature groups');
    entry.families.forEach((family: unknown, group: number) => {
      vector(family, FAMILY_SIZES[group]!, 'pooled feature group dimensions');
      distribution(family, 'pooled feature group');
      check(family.every((p) => p > 0), 'pooled probabilities must be smoothed');
    });
    const cutoffs = object(entry.cutoffs, 'pooled cutoffs');
    check(Number.isFinite(cutoffs.fit) && Number.isFinite(cutoffs.margin), 'pooled cutoffs must be finite');
  }
  const ids = models.map((model) => String(model.id));
  check(Array.isArray(pooled.pairs) && pooled.pairs.length === ids.length * (ids.length - 1), 'pooled pairs must cover every ordered model pair');
  const seen = new Set<string>();
  for (const value of pooled.pairs) {
    const pair = object(value, 'pooled pair');
    check(typeof pair.model === 'string' && typeof pair.competitor === 'string' && ids.includes(pair.model) && ids.includes(pair.competitor) && pair.model !== pair.competitor, 'pooled pair models');
    const key = `${pair.model}\n${pair.competitor}`;
    check(!seen.has(key), 'pooled pairs must be unique');
    seen.add(key);
    vector(pair.weights, FAMILY_SIZES.length, 'pooled pair weights');
    check(pair.weights.every((weight) => weight >= 0), 'pooled pair weights must be nonnegative');
    check(Number.isFinite(pair.center) && typeof pair.scale === 'number' && Number.isFinite(pair.scale) && pair.scale > 0, 'pooled pair center and scale');
  }
}

/** Validate untrusted JSON before it enters the math engine. Returns an independent copy. */
export function validateBank(input: unknown): FingerprintBank {
  const bank = object(input, 'root');
  check((bank.schemaVersion === 1 || bank.schemaVersion === 2) && bank.featureVersion === FEATURE_VERSION && bank.alpha === 0.5, 'unsupported schema, features, or smoothing');
  const protocol = object(bank.protocol, 'protocol');
  check(protocol.id === 'integer-v1' && ['en', 'zh'].includes(String(protocol.language)), 'protocol id/language');
  check(integer(protocol.targetSamples, MIN_SAMPLES, MAX_SAMPLES), `targetSamples must be between ${MIN_SAMPLES} and ${MAX_SAMPLES}`);
  check(protocol.temperature === null || (typeof protocol.temperature === 'number' && Number.isFinite(protocol.temperature) && protocol.temperature >= 0 && protocol.temperature <= 2), 'temperature');
  check((BANK_TRANSPORTS as readonly unknown[]).includes(protocol.transport), 'transport');
  check(Array.isArray(bank.nuisanceDirections) && bank.nuisanceDirections.length <= 32, 'nuisanceDirections');
  for (const direction of bank.nuisanceDirections) vector(direction, FEATURE_DIMENSION, 'nuisance direction dimensions');
  check(Array.isArray(bank.models) && bank.models.length > 0 && bank.models.length <= 32, 'expected 1–32 models');
  const ids = new Set<string>();
  let commonCheckpoints: string | undefined;
  let calibrated = 0;
  for (const value of bank.models) {
    const model = object(value, 'model');
    check(typeof model.id === 'string' && MODEL_ID_PATTERN.test(model.id) && !ids.has(model.id), 'model ids must be valid and unique');
    ids.add(model.id);
    check(typeof model.family === 'string' && model.family.length > 0 && model.family.length <= 128, 'model family');
    check(typeof model.provenance === 'string' && model.provenance.trim().length > 0 && model.provenance.length <= 4096, 'model provenance');
    check(model.status === 'uncalibrated' || model.status === 'calibrated', 'model status');
    vector(model.integerProbabilities, INTEGER_MAX, 'integerProbabilities');
    distribution(model.integerProbabilities, 'integerProbabilities');
    check(model.integerProbabilities.every((x) => x > 0), 'integer probabilities must be smoothed');
    check(Array.isArray(model.profiles) && model.profiles.length <= 32, 'profiles');
    const checkpoints: number[] = [];
    for (const entry of model.profiles) {
      const profile = object(entry, 'profile');
      check(integer(profile.sampleCount, MIN_SAMPLES, protocol.targetSamples), 'profile sampleCount');
      check(!checkpoints.length || profile.sampleCount > checkpoints[checkpoints.length - 1]!, 'profile counts must be sorted and unique');
      checkpoints.push(profile.sampleCount);
      vector(profile.centroid, FEATURE_DIMENSION, 'centroid');
      distribution(profile.centroid, 'centroid');
      vector(profile.variance, FEATURE_DIMENSION, 'variance');
      check(profile.variance.every((v) => v >= 0), 'negative variance');
      check(typeof profile.maxHellinger === 'number' && profile.maxHellinger >= 0 && profile.maxHellinger <= 1, 'Hellinger threshold');
      check(typeof profile.maxMahalanobis === 'number' && Number.isFinite(profile.maxMahalanobis) && profile.maxMahalanobis > 0, 'Mahalanobis threshold');
    }
    if (model.status === 'calibrated') {
      calibrated++;
      check(checkpoints.includes(protocol.targetSamples), 'calibrated profile required at targetSamples');
      const signature = checkpoints.join(',');
      check(commonCheckpoints === undefined || commonCheckpoints === signature, 'calibrated models must share checkpoints');
      commonCheckpoints = signature;
    }
  }
  if (bank.calibration !== null) {
    const calibration = object(bank.calibration, 'calibration');
    check(typeof calibration.source === 'string' && calibration.source.trim().length > 0, 'calibration source');
    check(integer(calibration.heldOutRuns, 2, 1_000_000), 'at least two held-out calibration runs required');
    check(typeof calibration.sequentialValidated === 'boolean', 'sequentialValidated');
  }
  check(!calibrated || bank.calibration !== null, 'calibrated models need calibration provenance');
  // Below this, the sequential test never accepts, so every probe would end INCONCLUSIVE.
  check(!calibrated || protocol.targetSamples >= MIN_SEQUENTIAL_SAMPLES, `calibrated banks need targetSamples of at least ${MIN_SEQUENTIAL_SAMPLES}`);
  // A version-1 reader rejects version 2, so a pooled bank is never probed with a single request.
  if (bank.schemaVersion === 2) validatePooled(bank, protocol, bank.models as Record<string, unknown>[]);
  else check(protocol.requestsPerProbe === undefined && protocol.scoring === undefined && bank.pooled === undefined, 'pooled scoring requires schemaVersion 2');
  return structuredClone(input) as FingerprintBank;
}

export function defaultBank(): FingerprintBank { return validateBank(defaults); }

/** The bundled experimental pooled bank (schema version 2), loaded on first use. */
export async function pooledBank(): Promise<FingerprintBank> {
  const { default: bank } = await import('./pooled_bank.json');
  return validateBank(bank);
}

export async function loadBank(path?: string): Promise<FingerprintBank> {
  if (!path) return defaultBank();
  const content = await readBoundedText(path, MAX_PAYLOAD_BYTES, () => invalidBank('Bank must be a JSON file no larger than 16 MiB'));
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw invalidBank('Fingerprint bank is not valid JSON'); }
  return validateBank(parsed);
}
