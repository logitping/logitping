import { describe, expect, it } from 'vitest';
import { countEvents, FAMILY_SIZES, familyLogLikelihoods, logLikelihoods, smoothFamilies, sumFamilies, type EventCounts } from '../src/math/pooled_features.js';

const entries = (group: EventCounts) => [...group.counts].sort(([a], [b]) => a - b);

describe('pooled feature groups', () => {
  it('counts the events of every group', () => {
    const groups = countEvents([1, 2, 355, 2, 20, 40, 1, 9, 9]);
    expect(groups.map((group) => group.total)).toEqual([9, 8, 8, 8, 6, 8, 9]);
    expect(entries(groups[0]!)).toEqual([[0, 2], [1, 2], [8, 2], [19, 1], [39, 1], [354, 1]]);
    expect(entries(groups[1]!)).toEqual([[0, 1], [1, 1], [2, 1], [8, 1], [18, 1], [20, 1], [316, 1], [353, 1]]);
    expect(entries(groups[2]!)).toEqual([[0, 3], [1, 1], [19, 1], [22, 1], [40, 1], [380, 1]]);
    expect(entries(groups[3]!)).toEqual([[0, 1], [1, 1], [12, 1], [19, 1], [20, 1], [25, 1], [52, 1], [99, 1]]);
    expect(entries(groups[4]!)).toEqual([[0, 1], [4, 1], [32, 1], [76, 1], [156, 1], [1416, 1]]);
    expect(entries(groups[5]!)).toEqual([[0, 1], [356, 1], [1064, 1], [1066, 1], [1439, 1], [1814, 1], [2130, 1], [2493, 1]]);
    expect(entries(groups[6]!)).toEqual([[0, 6], [1, 1], [2, 1], [3, 1]]);
  });

  it('places first uses by quarter of a 355-position run and bins values every 17.75', () => {
    const firstUse = countEvents(Array.from({ length: 100 }, (_, t) => t + 1))[4]!.counts;
    // Value 89 is first used at t = 88 (quarter 0); value 90 at t = 89 (quarter 1).
    expect(firstUse.has(88 * 4)).toBe(true);
    expect(firstUse.has(89 * 4 + 1)).toBe(true);
    expect(entries(countEvents([18, 19])[2]!)).toEqual([[1, 1]]);
  });

  it('caps repeat gaps at bin 11', () => {
    const run = [5, ...Array.from({ length: 2100 }, (_, t) => (t % 300) + 10), 5];
    expect(countEvents(run)[6]!.counts.get(11)).toBe(1);
  });

  it('rejects integers outside [1, 355]', () => {
    expect(() => countEvents([1, 356])).toThrow(RangeError);
    expect(() => countEvents([0, 1])).toThrow(RangeError);
  });

  it('smooths pooled counts into distributions of the group sizes', () => {
    const families = smoothFamilies(sumFamilies([countEvents([1, 1]), countEvents([2, 3])]));
    expect(families.map((family) => family.length)).toEqual([...FAMILY_SIZES]);
    for (const family of families) expect(family.reduce((sum, p) => sum + p, 0)).toBeCloseTo(1, 12);
    expect(families[0]![0]).toBeCloseTo(2.5 / (4 + 0.5 * 355), 15);
  });

  it('leaves a run out of its own model exactly', () => {
    const a = countEvents([3, 7, 7, 300, 12, 3]);
    const b = countEvents([4, 7, 8, 299, 12, 5]);
    const both = sumFamilies([a, b]);
    const left = logLikelihoods(a, both, a);
    const reference = logLikelihoods(a, sumFamilies([b]));
    left.forEach((value, group) => expect(value).toBeCloseTo(reference[group]!, 12));
    expect(logLikelihoods(a, both)).not.toEqual(left);
  });

  it('gives the same likelihood from stored probabilities as from counts', () => {
    const totals = sumFamilies([countEvents([3, 7, 7, 300]), countEvents([4, 7, 8, 299])]);
    const run = countEvents([7, 7, 12, 300]);
    const fromProbabilities = familyLogLikelihoods(run, smoothFamilies(totals).map((family) => family.map(Math.log)));
    logLikelihoods(run, totals).forEach((value, group) => expect(fromProbabilities[group]).toBeCloseTo(value, 9));
  });
});
