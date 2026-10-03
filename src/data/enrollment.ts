import type { FingerprintBank, ModelFingerprint } from '../core/types.js';
import { smoothCounts } from '../math/hellinger.js';
import { createNuisanceProjector } from '../math/nuisance.js';
import { assessOOD } from '../math/ood.js';
import { BLOCK_COUNT, FEATURE_DIMENSION, FEATURE_VERSION, INTEGER_MAX, integerHistogram, orderedBlockFeatures } from '../math/ordered_block.js';
import { MIN_SEQUENTIAL_SAMPLES } from '../math/sprt.js';
import { isRecord, MAX_SAMPLES, MIN_SAMPLES } from '../util/validate.js';
import { validateBank } from './bank_loader.js';

export interface EnrollmentInput {
  source: string;
  protocol: FingerprintBank['protocol'];
  checkpoints: number[];
  nuisanceDirections?: number[][];
  models: {
    id: string;
    family: string;
    /** Independent, labeled runs from an independently trusted endpoint. */
    training: number[][];
    /** Separate runs; never reuse training observations for threshold selection. */
    validation: number[][];
  }[];
}

/** Recorded in collection provenance; change it whenever the variance estimator changes. */
export const VARIANCE_METHOD = 'block-median-shrinkage-v1';
/** Pseudo-observations that pull each dimension's variance toward its feature block's typical variance. */
const VARIANCE_PRIOR_WEIGHT = 4;
/** Matches the floor in diagonalMahalanobis(). */
const VARIANCE_FLOOR = 1e-8;

/**
 * Empirical-Bayes shrinkage of per-dimension variances toward the median positive variance of their
 * feature block (whole sequence, each temporal block, endings). Without it, a dimension where every
 * training run happened to agree gets a near-zero variance, and a one-count difference there
 * dominates the Mahalanobis distance. Positive variances set the scale because most dimensions of
 * a sparse block never occur in training at all.
 */
function regularizeVariance(raw: readonly number[], dof: number): number[] {
  const bounds = [0, ...Array.from({ length: BLOCK_COUNT + 1 }, (_, block) => INTEGER_MAX * (block + 1)), FEATURE_DIMENSION];
  const variance = raw.slice();
  for (let block = 0; block + 1 < bounds.length; block++) {
    const start = bounds[block]!;
    const end = bounds[block + 1]!;
    const positive = raw.slice(start, end).filter((value) => value > 0).sort((a, b) => a - b);
    const prior = Math.max(positive[positive.length >> 1] ?? 0, VARIANCE_FLOOR);
    for (let i = start; i < end; i++) variance[i] = (dof * raw[i]! + VARIANCE_PRIOR_WEIGHT * prior) / (dof + VARIANCE_PRIOR_WEIGHT);
  }
  return variance;
}

/**
 * Build empirical centroids and held-out distance envelopes, not accuracy guarantees.
 *
 * Each envelope is the largest of `n` held-out distances plus a 10% margin. If a genuine run is
 * exchangeable with the held-out runs, it exceeds that maximum with probability about 1/(n + 1)
 * per statistic, before the margin: 33% at the two-run minimum, 17% with five runs. Hellinger and
 * Mahalanobis gates are both applied, so the false-reject rate can approach twice that. About 19
 * held-out runs are needed for a nominal 5% per statistic.
 */
export function createFingerprintBank(input: EnrollmentInput): FingerprintBank {
  if (!input || !Array.isArray(input.models) || !input.models.length || input.models.length > 32 ||
      !Array.isArray(input.checkpoints) || !input.checkpoints.length || input.checkpoints.length > 32) {
    throw new TypeError('Enrollment requires models and checkpoints');
  }
  // Enrollment always calibrates, and the sequential test accepts nothing before its minimum.
  if (!input.protocol || !Number.isInteger(input.protocol.targetSamples) || input.protocol.targetSamples < MIN_SEQUENTIAL_SAMPLES || input.protocol.targetSamples > MAX_SAMPLES) {
    throw new TypeError(`Enrollment targetSamples must be between ${MIN_SEQUENTIAL_SAMPLES} and ${MAX_SAMPLES}`);
  }
  const directions = input.nuisanceDirections ?? [];
  if (!Array.isArray(directions) || directions.length > 32 || directions.some((v) => !Array.isArray(v) || v.length !== FEATURE_DIMENSION)) {
    throw new TypeError('Invalid enrollment nuisance directions');
  }
  const project = createNuisanceProjector(directions);
  const models: ModelFingerprint[] = input.models.map((model) => {
    // Untyped JSON from bank-create may hold null or primitive entries.
    if (!isRecord(model)) throw new TypeError('Every enrollment model must be an object');
    if (!Array.isArray(model.training) || model.training.length < 3 || !Array.isArray(model.validation) || model.validation.length < 2) {
      throw new TypeError('Enrollment needs at least three independent training runs and two held-out runs per model');
    }
    for (const run of [...model.training, ...model.validation]) {
      if (!Array.isArray(run) || run.length !== input.protocol.targetSamples) throw new TypeError('Every enrollment run must match the target sample budget');
      integerHistogram(run);
    }
    const counts = integerHistogram(model.training.flat());
    const profiles = input.checkpoints.map((sampleCount) => {
      if (!Number.isInteger(sampleCount) || sampleCount < MIN_SAMPLES || sampleCount > input.protocol.targetSamples) throw new TypeError('Invalid enrollment checkpoint');
      const training = model.training.map((run) => orderedBlockFeatures(run.slice(0, sampleCount)).vector);
      const centroid = Array<number>(FEATURE_DIMENSION).fill(0);
      for (const features of training) {
        for (let i = 0; i < centroid.length; i++) centroid[i]! += features[i]! / training.length;
      }
      const residuals = training.map((features) => project(features.map((p, i) => Math.sqrt(p) - Math.sqrt(centroid[i]!))));
      const means = Array<number>(FEATURE_DIMENSION).fill(0);
      for (const residual of residuals) for (let i = 0; i < means.length; i++) means[i]! += residual[i]! / residuals.length;
      const raw = Array<number>(FEATURE_DIMENSION).fill(0);
      for (const residual of residuals) {
        for (let i = 0; i < raw.length; i++) raw[i]! += (residual[i]! - means[i]!) ** 2 / (residuals.length - 1);
      }
      const variance = regularizeVariance(raw, residuals.length - 1);
      const profile = { sampleCount, centroid, variance, maxHellinger: 1, maxMahalanobis: Number.MAX_VALUE };
      const validation = model.validation.map((run) => assessOOD(orderedBlockFeatures(run.slice(0, sampleCount)).vector, profile, project));
      profile.maxHellinger = Math.min(1, Math.max(...validation.map((v) => v.hellinger)) * 1.1 + 1e-6);
      profile.maxMahalanobis = Math.max(...validation.map((v) => v.mahalanobis)) * 1.1 + 1e-6;
      return profile;
    });
    return { id: model.id, family: model.family, status: 'calibrated', integerProbabilities: smoothCounts(counts), profiles, provenance: input.source };
  });
  return validateBank({
    schemaVersion: 1, featureVersion: FEATURE_VERSION, protocol: input.protocol, alpha: 0.5,
    nuisanceDirections: directions, models,
    calibration: { source: input.source, heldOutRuns: input.models.reduce((sum, model) => sum + model.validation.length, 0), sequentialValidated: false },
  });
}
