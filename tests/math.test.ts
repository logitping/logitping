import { describe, expect, it } from 'vitest';
import { hellinger, smoothCounts } from '../src/math/hellinger.js';
import { FEATURE_DIMENSION, orderedBlockFeatures } from '../src/math/ordered_block.js';
import { createNuisanceProjector, dot, gramSchmidt, projectNuisance } from '../src/math/nuisance.js';
import { SequentialTest } from '../src/math/sprt.js';
import { assessOOD, diagonalMahalanobis } from '../src/math/ood.js';
import { createFingerprintBank, type EnrollmentInput } from '../src/data/enrollment.js';

describe('Hellinger geometry and smoothing', () => {
  it('has identity, symmetry, and disjoint support bounds', () => {
    expect(hellinger([0.2, 0.8], [0.2, 0.8])).toBe(0);
    expect(hellinger([1, 0], [0, 1])).toBe(1);
    expect(hellinger([0.1, 0.9], [0.3, 0.7])).toBeCloseTo(hellinger([0.3, 0.7], [0.1, 0.9]), 14);
  });
  it('uses alpha=0.5 and handles empty bins', () => {
    expect(smoothCounts([0, 0])).toEqual([0.5, 0.5]);
    expect(smoothCounts([3, 0])).toEqual([0.875, 0.125]);
  });
  it.each([{ p: [] }, { p: [NaN, 1] }, { p: [-1, 2] }, { p: [0.2, 0.2] }])('rejects malformed probabilities $p', ({ p }) => {
    expect(() => hellinger(p, [0.5, 0.5])).toThrow();
  });
  it('rejects invalid counts and unequal dimensions', () => {
    expect(() => smoothCounts([0, 0], 0)).toThrow();
    expect(() => smoothCounts([1, -1])).toThrow();
    expect(() => smoothCounts([1], NaN)).toThrow();
    expect(() => hellinger([1], [0.5, 0.5])).toThrow();
  });
});

describe('ordered block features', () => {
  it('distinguishes sequences with identical global counts but different temporal order', () => {
    const a = orderedBlockFeatures([1, 1, 2, 2, 3, 3, 4, 4]);
    const b = orderedBlockFeatures([4, 4, 3, 3, 2, 2, 1, 1]);
    expect(a.global).toEqual(b.global);
    expect(a.endings).toEqual(b.endings);
    expect(hellinger(a.vector, b.vector)).toBeGreaterThan(0);
    expect(a.vector).toHaveLength(FEATURE_DIMENSION);
    expect(a.vector.reduce((a, b) => a + b)).toBeCloseTo(1, 12);
  });
  it('includes the upper boundary and maps modulo-10 correctly', () => {
    const features = orderedBlockFeatures([355, 10, 20]);
    expect(features.endings[0]).toBeGreaterThan(features.endings[5]!);
    expect(features.global[354]).toBeGreaterThan(features.global[0]!);
  });
  it('smooths short and empty blocks without NaNs', () => {
    for (const samples of [[], [1], [1, 2, 3, 4, 5]]) {
      const { vector, blocks } = orderedBlockFeatures(samples);
      expect(blocks).toHaveLength(4);
      expect(vector.every(Number.isFinite)).toBe(true);
      expect(vector.reduce((a, b) => a + b)).toBeCloseTo(1, 12);
    }
  });
  it.each([0, 356, 1.2, NaN])('rejects invalid sample %s', (value) => {
    expect(() => orderedBlockFeatures([value])).toThrow();
  });
});

describe('nuisance projection', () => {
  it('creates an orthonormal basis and drops dependent and zero directions', () => {
    const basis = gramSchmidt([[1, 1, 0], [2, 2, 0], [0, 0, 0], [1, 0, 1]]);
    expect(basis).toHaveLength(2);
    expect(dot(basis[0]!, basis[1]!)).toBeCloseTo(0, 14);
    for (const axis of basis) expect(dot(axis, axis)).toBeCloseTo(1, 14);
  });
  it('is idempotent, contracts distance, and removes only the nuisance component', () => {
    const input = [3, 4, 5];
    const directions = [[1, 1, 0]];
    const residual = projectNuisance(input, directions);
    expect(residual[2]).toBe(5);
    expect(dot(residual, directions[0]!)).toBeCloseTo(0, 13);
    expect(Math.hypot(...residual)).toBeLessThan(Math.hypot(...input));
    projectNuisance(residual, directions).forEach((x, i) => expect(x).toBeCloseTo(residual[i]!, 13));
    expect(projectNuisance(input, [])).toEqual(input);
  });
  it('handles vectors longer than the engine argument limit', () => {
    const long = Array.from({ length: 200_000 }, (_, i) => (i % 7) - 3);
    expect(gramSchmidt([long])[0]!.length).toBe(200_000);
    expect(dot(gramSchmidt([long])[0]!, gramSchmidt([long])[0]!)).toBeCloseTo(1, 12);
  });
  it('rejects mismatched dimensions and nonfinite directions', () => {
    expect(() => gramSchmidt([[1, 0], [1]])).toThrow();
    expect(() => projectNuisance([1], [[1, 0]])).toThrow();
    expect(() => gramSchmidt([[NaN]])).toThrow();
  });
});

describe('sequential test', () => {
  const hypotheses = [{ id: 'a', probabilities: [0.9, 0.1] }, { id: 'b', probabilities: [0.1, 0.9] }];
  it('agrees with an analytic log likelihood ratio and respects minimum evidence', () => {
    const test = new SequentialTest(hypotheses, 0.005, 10);
    for (let i = 0; i < 9; i++) expect(test.update(0).accepted).toBe(false);
    const result = test.update(0);
    expect(result.accepted).toBe(true);
    expect(result.winner).toBe('a');
    expect(result.logLikelihoodRatio).toBeCloseTo(10 * Math.log(9), 12);
    expect(result.weights.a).toBeGreaterThan(0.995);
    expect(result.threshold).toBeCloseTo(Math.log(200));
  });
  it('does not force a decision for identical distributions', () => {
    const test = new SequentialTest([{ id: 'a', probabilities: [0.5, 0.5] }, { id: 'b', probabilities: [0.5, 0.5] }]);
    for (let i = 0; i < 1000; i++) test.update(i % 2);
    expect(test.snapshot().accepted).toBe(false);
    expect(test.snapshot().weights).toEqual({ a: 0.5, b: 0.5 });
  });
  it('tightens the threshold for additional alternatives and stays finite', () => {
    const test = new SequentialTest([...hypotheses, { id: 'c', probabilities: [0.5, 0.5] }]);
    expect(test.threshold).toBeCloseTo(Math.log(400));
    for (let i = 0; i < 10_000; i++) test.update(0);
    expect(Object.values(test.snapshot().weights).every(Number.isFinite)).toBe(true);
  });
  it('rejects zeros, duplicates, and invalid categories', () => {
    expect(() => new SequentialTest([{ id: 'a', probabilities: [1, 0] }, hypotheses[1]!])).toThrow();
    expect(() => new SequentialTest([hypotheses[0]!, hypotheses[0]!])).toThrow();
    expect(() => new SequentialTest(hypotheses).update(2)).toThrow();
  });
});

describe('open-set gate', () => {
  const profile = { centroid: [0.8, 0.2], variance: [0.01, 0.01], maxHellinger: 0.2, maxMahalanobis: 4 };
  it('accepts its centroid and rejects a remote distribution before ranking', () => {
    expect(assessOOD([0.8, 0.2], profile).accepted).toBe(true);
    expect(assessOOD([0.01, 0.99], profile).accepted).toBe(false);
    expect(diagonalMahalanobis([3, 4], [1, 1])).toBe(5);
  });
  it('regularizes zero variance and projects in sqrt space', () => {
    expect(Number.isFinite(diagonalMahalanobis([1, 0], [0, 0]))).toBe(true);
    const q = [0.4, 0.6];
    const direction = q.map((p, i) => Math.sqrt(p) - Math.sqrt(profile.centroid[i]!));
    expect(assessOOD(q, profile, [direction]).hellinger).toBeCloseTo(0, 14);
  });
  it('gives identical results with a precompiled nuisance projector', () => {
    const direction = [0.3, -0.1];
    const project = createNuisanceProjector([direction]);
    for (const q of [[0.4, 0.6], [0.8, 0.2], [0.05, 0.95]]) {
      expect(assessOOD(q, profile, project)).toEqual(assessOOD(q, profile, [direction]));
    }
  });
});

describe('enrollment variance regularization', () => {
  // Runs cover 1..40 in shifted orders; no training run contains 300.
  const run = (seed: number) => Array.from({ length: 64 }, (_, i) => ((i * 7 + seed * 13) % 40) + 1);
  const bank = createFingerprintBank({
    source: 'SYNTHETIC variance fixture', checkpoints: [64],
    protocol: { id: 'integer-v1', targetSamples: 64, language: 'en', temperature: null, transport: 'openai' },
    models: [{ id: 'm', family: 'synthetic', training: Array.from({ length: 10 }, (_, i) => run(i)), validation: [run(10), run(11)] }],
  });
  const profile = bank.models[0]!.profiles[0]!;
  const mahalanobis = (samples: number[]) => assessOOD(orderedBlockFeatures(samples).vector, profile).mahalanobis;

  it('does not let one unseen integer dominate the distance', () => {
    const changed = run(0);
    changed[0] = 300;
    // With an unregularized 1e-8 variance this single count added about 180.
    expect(mahalanobis(changed) - mahalanobis(run(0))).toBeLessThan(5);
    expect(mahalanobis(changed)).toBeLessThanOrEqual(profile.maxMahalanobis);
  });
  it('shrinks dimensions every training run agreed on toward the block scale', () => {
    const unseen = profile.variance.slice(40, 355);
    const varying = profile.variance.slice(0, 40).sort((a, b) => a - b);
    expect(Math.min(...unseen)).toBeGreaterThan(varying[0]! / 10);
  });
});

describe('enrollment input validation', () => {
  const run = Array<number>(64).fill(17);
  const valid = (): EnrollmentInput => ({
    source: 'SYNTHETIC validation fixture', checkpoints: [64],
    protocol: { id: 'integer-v1', targetSamples: 64, language: 'en', temperature: null, transport: 'openai' },
    models: [{ id: 'm', family: 'synthetic', training: [run, run, run], validation: [run, run] }],
  });
  it('accepts the valid fixture', () => {
    expect(createFingerprintBank(valid()).models).toHaveLength(1);
  });
  it.each([
    ['no models', (input: EnrollmentInput) => ({ ...input, models: [] })],
    ['an out-of-range sample budget', (input: EnrollmentInput) => ({ ...input, protocol: { ...input.protocol, targetSamples: 2 } })],
    ['a sample budget below the sequential minimum', (input: EnrollmentInput) => {
      const short = run.slice(0, 32);
      return { ...input, checkpoints: [32], protocol: { ...input.protocol, targetSamples: 32 },
        models: [{ ...input.models[0]!, training: [short, short, short], validation: [short, short] }] };
    }],
    ['nuisance directions of the wrong dimension', (input: EnrollmentInput) => ({ ...input, nuisanceDirections: [[1]] })],
    ['a model that is not an object', (input: EnrollmentInput) => ({ ...input, models: [null] })],
    ['too few training runs', (input: EnrollmentInput) => ({ ...input, models: [{ ...input.models[0]!, training: [run, run] }] })],
    ['a run of the wrong length', (input: EnrollmentInput) => ({ ...input, models: [{ ...input.models[0]!, validation: [run, run.slice(1)] }] })],
    ['a checkpoint beyond the sample budget', (input: EnrollmentInput) => ({ ...input, checkpoints: [128] })],
  ])('reports %s as a TypeError: invalid caller input, not a probe failure', (_label, change) => {
    expect(() => createFingerprintBank(change(valid()) as EnrollmentInput)).toThrow(TypeError);
  });
});
