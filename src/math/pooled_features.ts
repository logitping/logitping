import { assertIntegerSample, INTEGER_MAX } from './ordered_block.js';

/** Scoring method of pooled banks; it fixes the feature groups below. */
export const POOLED_SCORING = 'pooled-sets-v1' as const;
/** Category counts of the seven feature groups, in order. */
export const FAMILY_SIZES = [INTEGER_MAX, INTEGER_MAX, 400, 100, INTEGER_MAX * 4, INTEGER_MAX * 8, 12] as const;
/** Jeffreys smoothing, as in the v1 bank. */
const SMOOTHING = 0.5;

/** Event counts of one run in one feature group. */
export interface EventCounts {
  counts: Map<number, number>;
  total: number;
}

/** Summed event counts of a model's runs, per group. */
export interface FamilyTotals {
  counts: Float64Array[];
  totals: number[];
}

const N = INTEGER_MAX;
/** Frozen as evaluated offline; changing any definition needs a new scoring id. */
const GROUPS: readonly ((run: readonly number[]) => number[])[] = [
  // Value.
  (run) => run.map((x) => x - 1),
  // Step between consecutive values, modulo 355.
  (run) => run.slice(1).map((x, t) => (x - run[t]! + N) % N),
  // Consecutive value bins: 20 bins of 17.75 values.
  (run) => run.slice(1).map((x, t) => Math.floor((run[t]! - 1) / 17.75) * 20 + Math.floor((x - 1) / 17.75)),
  // Consecutive last digits.
  (run) => run.slice(1).map((x, t) => (run[t]! % 10) * 10 + (x % 10)),
  // Each value's first use, by quarter of a 355-position run.
  (run) => {
    const seen = new Set<number>();
    const events: number[] = [];
    run.forEach((x, t) => {
      if (!seen.has(x)) { seen.add(x); events.push((x - 1) * 4 + Math.min(3, Math.floor(t / 89))); }
    });
    return events;
  },
  // Opening: the value at each of the first 8 positions.
  (run) => run.slice(0, 8).map((x, t) => t * N + x - 1),
  // Positions since the value last appeared, in log2 bins; 0 for a first occurrence.
  (run) => {
    const last = new Map<number, number>();
    return run.map((x, t) => {
      const previous = last.get(x);
      last.set(x, t);
      return previous === undefined ? 0 : Math.min(11, 1 + Math.floor(Math.log2(t - previous)));
    });
  },
];

/** Count each feature group's events in one run of integers in [1, 355]. */
export function countEvents(run: readonly number[]): EventCounts[] {
  for (const value of run) assertIntegerSample(value);
  return GROUPS.map((group) => {
    const counts = new Map<number, number>();
    const events = group(run);
    for (const event of events) counts.set(event, (counts.get(event) ?? 0) + 1);
    return { counts, total: events.length };
  });
}

export function sumFamilies(runs: readonly (readonly EventCounts[])[]): FamilyTotals {
  const counts = FAMILY_SIZES.map((size) => new Float64Array(size));
  const totals = FAMILY_SIZES.map(() => 0);
  for (const run of runs) {
    run.forEach(({ counts: events, total }, group) => {
      for (const [event, count] of events) counts[group]![event]! += count;
      totals[group]! += total;
    });
  }
  return { counts, totals };
}

/** Jeffreys-smoothed probabilities of each group. */
export function smoothFamilies(totals: FamilyTotals): number[][] {
  return FAMILY_SIZES.map((size, group) => Array.from(totals.counts[group]!, (count) => (count + SMOOTHING) / (totals.totals[group]! + SMOOTHING * size)));
}

/** Per-group log-likelihoods of `run` under smoothed `totals`, optionally with one of the model's own runs left out. */
export function logLikelihoods(run: readonly EventCounts[], totals: FamilyTotals, leaveOut?: readonly EventCounts[]): number[] {
  return run.map(({ counts }, group) => {
    const removed = leaveOut?.[group];
    const logDenominator = Math.log(totals.totals[group]! - (removed?.total ?? 0) + SMOOTHING * FAMILY_SIZES[group]!);
    let sum = 0;
    for (const [event, count] of counts) {
      sum += count * (Math.log(totals.counts[group]![event]! - (removed?.counts.get(event) ?? 0) + SMOOTHING) - logDenominator);
    }
    return sum;
  });
}

/** Per-group log-likelihoods of `run` under stored per-group log probabilities. */
export function familyLogLikelihoods(run: readonly EventCounts[], logProbabilities: readonly (readonly number[])[]): number[] {
  return run.map(({ counts }, group) => {
    let sum = 0;
    for (const [event, count] of counts) sum += count * logProbabilities[group]![event]!;
    return sum;
  });
}
