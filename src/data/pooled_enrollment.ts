import type { FingerprintBank, PooledScoring } from '../core/types.js';
import { countEvents, logLikelihoods, POOLED_SCORING, smoothFamilies, sumFamilies, type EventCounts, type FamilyTotals } from '../math/pooled_features.js';
import { aggregateScores, cutoffIndex, fitPairStatistic, mulberry32, pairScore, type PairStatistic } from '../math/pooled_sets.js';
import { validateBank } from './bank_loader.js';
import { createFingerprintBank, type EnrollmentInput } from './enrollment.js';

/** Target miscoverage of a pooled bank, split equally between the fit and margin tests. */
export const POOLED_ALPHA = 0.2;
export const POOLED_DRAWS = 2000;
export const POOLED_SEED = 20261011;

export interface PooledOptions {
  requestsPerProbe: number;
  /** Bootstrap seed; recorded in the bank. Defaults to POOLED_SEED. */
  seed?: number;
}

export type PooledEnrollmentInput = EnrollmentInput & PooledOptions;

/** Labeled runs behind a bank's models, in bank order. */
export type EnrolledRuns = readonly { readonly id: string; readonly training: readonly (readonly number[])[]; readonly validation: readonly (readonly number[])[] }[];

export interface Calibration {
  totals: FamilyTotals[];
  /** Pair statistic of model m against competitor o, fitted on all runs of both. */
  pair(m: number, o: number): PairStatistic;
  /** Model m's calibration components: each run's fit and margins come from statistics fitted without it. */
  components(m: number): { fit: number; margins: number[] }[];
}

/** Cross-fitted statistics over `events[model][run][group]`, where every run of a model calibrates it. */
export function prepareCalibration(events: readonly (readonly (readonly EventCounts[])[])[]): Calibration {
  const totals = events.map((runs) => sumFamilies(runs));
  // ll[a][i][m]: run i of model a under model m, leaving the run out of its own model.
  const ll = events.map((runs, a) => runs.map((run) => totals.map((model, m) => logLikelihoods(run, model, m === a ? run : undefined))));
  const ratio = (a: number, i: number, m: number, o: number) => ll[a]![i]![m]!.map((value, group) => value - ll[a]![i]![o]![group]!);
  const indices = (a: number) => events[a]!.map((_, i) => i);
  const fit = (m: number, own: readonly number[], o: number) =>
    fitPairStatistic(own.map((i) => ratio(m, i, m, o)), indices(o).map((j) => ratio(o, j, m, o)));
  return {
    totals,
    pair: (m, o) => fit(m, indices(m), o),
    components: (m) => indices(m).map((i) => ({
      fit: ll[m]![i]![m]!.reduce((sum, value) => sum + value, 0),
      margins: events.map((_, o) => o).filter((o) => o !== m)
        .map((o) => pairScore(fit(m, indices(m).filter((j) => j !== i), o), ratio(m, i, m, o))),
    })),
  };
}

/**
 * Extend a v1 bank with prediction-set calibration fitted from the same runs (schema version 2).
 * Envelopes, probabilities, and provenance stay as they are.
 */
export function attachPooledScoring(bank: FingerprintBank, runs: EnrolledRuns, options: PooledOptions): FingerprintBank {
  const { requestsPerProbe, seed = POOLED_SEED } = options;
  if (!Number.isInteger(requestsPerProbe) || requestsPerProbe < 2 || requestsPerProbe > 64) throw new TypeError('requestsPerProbe must be an integer from 2 to 64');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new TypeError('The pooled bootstrap seed must be an unsigned 32-bit integer');
  if (bank.schemaVersion !== 1 || bank.models.length < 2) throw new TypeError('Pooled scoring extends a v1 bank of at least two models');
  if (runs.length !== bank.models.length || runs.some((model, index) => model.id !== bank.models[index]!.id)) {
    throw new TypeError('Pooled enrollment runs must list the bank models in bank order');
  }
  const events = runs.map((model) => [...model.training, ...model.validation].map((run) => {
    if (run.length !== bank.protocol.targetSamples) throw new TypeError('Every pooled enrollment run must match the target sample budget');
    return countEvents(run);
  }));
  const calibration = prepareCalibration(events);
  const pairs: PooledScoring['pairs'] = [];
  for (const [m, model] of runs.entries()) {
    for (const [o, competitor] of runs.entries()) if (o !== m) pairs.push({ model: model.id, competitor: competitor.id, ...calibration.pair(m, o) });
  }
  const random = mulberry32(seed);
  const index = cutoffIndex(POOLED_ALPHA, POOLED_DRAWS);
  const models = runs.map((_, m) => {
    const components = calibration.components(m);
    const fits: number[] = [];
    const margins: number[] = [];
    for (let draw = 0; draw < POOLED_DRAWS; draw++) {
      const tuple = Array.from({ length: requestsPerProbe }, () => components[Math.floor(random() * components.length)]!);
      const scores = aggregateScores(tuple.map((part) => part.fit), tuple.map((part) => part.margins));
      fits.push(scores.fit);
      margins.push(scores.margin);
    }
    fits.sort((a, b) => a - b);
    margins.sort((a, b) => a - b);
    return { families: smoothFamilies(calibration.totals[m]!), cutoffs: { fit: fits[index]!, margin: margins[index]! } };
  });
  return validateBank({
    ...bank, schemaVersion: 2,
    protocol: { ...bank.protocol, requestsPerProbe, scoring: POOLED_SCORING },
    pooled: { alpha: POOLED_ALPHA, bootstrap: { draws: POOLED_DRAWS, seed }, models, pairs },
  });
}

/** Build a pooled bank from labeled runs: v1 envelopes plus prediction-set calibration. */
export function createPooledBank(input: PooledEnrollmentInput): FingerprintBank {
  const { requestsPerProbe, seed, ...enrollment } = input;
  return attachPooledScoring(createFingerprintBank(enrollment), enrollment.models, { requestsPerProbe, ...(seed === undefined ? {} : { seed }) });
}
