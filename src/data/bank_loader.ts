import defaults from './default_bank.json';
import { LogitpingError } from '../core/errors.js';
import type { FingerprintBank } from '../core/types.js';
import { assertDistribution } from '../math/hellinger.js';
import { FEATURE_DIMENSION, FEATURE_VERSION, INTEGER_MAX } from '../math/ordered_block.js';
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

/** Validate untrusted JSON before it enters the math engine. Returns an independent copy. */
export function validateBank(input: unknown): FingerprintBank {
  const bank = object(input, 'root');
  check(bank.schemaVersion === 1 && bank.featureVersion === FEATURE_VERSION && bank.alpha === 0.5, 'unsupported schema, features, or smoothing');
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
  return structuredClone(input) as FingerprintBank;
}

export function defaultBank(): FingerprintBank { return validateBank(defaults); }

export async function loadBank(path?: string): Promise<FingerprintBank> {
  if (!path) return defaultBank();
  const content = await readBoundedText(path, MAX_PAYLOAD_BYTES, () => invalidBank('Bank must be a JSON file no larger than 16 MiB'));
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw invalidBank('Fingerprint bank is not valid JSON'); }
  return validateBank(parsed);
}
