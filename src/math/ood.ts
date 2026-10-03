import { assertDistribution, assertVector } from './hellinger.js';
import { createNuisanceProjector, dot, type Projector } from './nuisance.js';

export interface DistanceProfile {
  centroid: readonly number[];
  /** Variance of projected sqrt(features), estimated from separate training runs. */
  variance: readonly number[];
  maxHellinger: number;
  maxMahalanobis: number;
}

export function diagonalMahalanobis(delta: readonly number[], variance: readonly number[], floor = 1e-8): number {
  assertVector(delta);
  assertVector(variance);
  if (delta.length !== variance.length || variance.some((v) => v < 0) || !Number.isFinite(floor) || floor <= 0) {
    throw new RangeError('Invalid Mahalanobis variance or dimensions');
  }
  let squared = 0;
  for (let i = 0; i < delta.length; i++) squared += delta[i]! ** 2 / Math.max(floor, variance[i]!);
  return Math.sqrt(squared);
}

/**
 * Gate in feature space before computing any closed-set ranking or confidence.
 * Pass a projector from createNuisanceProjector() when assessing many observations.
 */
export function assessOOD(
  features: readonly number[],
  profile: DistanceProfile,
  directions: readonly (readonly number[])[] | Projector = [],
): { hellinger: number; mahalanobis: number; accepted: boolean } {
  assertDistribution(features);
  assertDistribution(profile.centroid);
  if (features.length !== profile.centroid.length) throw new RangeError('Feature dimensions must match');
  if (!(profile.maxHellinger >= 0 && profile.maxHellinger <= 1) ||
      !Number.isFinite(profile.maxMahalanobis) || profile.maxMahalanobis <= 0) {
    throw new RangeError('Invalid OOD thresholds');
  }
  const delta = features.map((p, i) => Math.sqrt(p) - Math.sqrt(profile.centroid[i]!));
  const project = typeof directions === 'function' ? directions : createNuisanceProjector(directions);
  const projected = project(delta);
  const hellinger = Math.sqrt(dot(projected, projected)) / Math.SQRT2;
  const mahalanobis = diagonalMahalanobis(projected, profile.variance);
  return { hellinger, mahalanobis, accepted: hellinger <= profile.maxHellinger && mahalanobis <= profile.maxMahalanobis };
}
