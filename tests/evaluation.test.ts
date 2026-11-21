import { describe, expect, it } from 'vitest';
import { createFingerprintBank } from '../src/data/enrollment.js';
import { evaluateDefaultBank, evaluatePooledBank, groupRuns, parseStoredCorpus, type SetTally, type StatusTally, type StoredCorpus } from '../src/data/evaluation.js';
import { corpusDigest } from '../src/data/gateway_plan.js';
import { createPooledBank } from '../src/data/pooled_enrollment.js';
import { forceCutoffs, openEnvelopes, syntheticEnrollment, syntheticRun } from './fixtures.js';

const PROTOCOL = { id: 'integer-v1', language: 'en', targetSamples: 128, temperature: null, transport: 'openai' } as const;
const constant = (value: number, count: number) => Array.from({ length: count }, () => Array<number>(128).fill(value));
const model = (id: string, value: number, training: number, validation = 0) => ({ id, training: constant(value, training), validation: constant(value, validation) });
const corpus = (collectedAt: string, models: StoredCorpus['models']): StoredCorpus => ({ collectedAt, protocol: { ...PROTOCOL }, checkpoints: [64, 128], models });
const tally = (fields: Partial<StatusTally>): StatusTally => ({ runs: 0, correct: 0, wrong: {}, inconclusive: 0, unknown: 0, ...fields });

// The bank is fitted from `own`, which also holds a model it does not enroll (synthetic-200).
const own = corpus('2026-01-01T00:00:00.000Z', [model('synthetic-17', 17, 3, 2), model('synthetic-150', 150, 3, 2), model('synthetic-287', 287, 3, 2), model('synthetic-200', 200, 3, 2)]);
const ownDigest = corpusDigest(own);
const bank = createFingerprintBank({
  source: `SYNTHETIC TEST FIXTURE; corpus sha256:${ownDigest}; no real model measurements`, protocol: PROTOCOL, checkpoints: [64, 128],
  models: own.models.slice(0, 3).map((entry) => ({ ...entry, family: 'synthetic' })),
});
// Another collection. synthetic-150's runs are mislabeled 17s, so they are named wrongly.
const other = corpus('2026-01-02T00:00:00.000Z', [model('synthetic-17', 17, 2), model('synthetic-150', 17, 2), model('synthetic-200', 200, 2)]);
const otherDigest = corpusDigest(other);

describe('stored corpora', () => {
  it('parses a corpus and names it by its content digest', () => {
    expect(parseStoredCorpus(JSON.parse(JSON.stringify({ schemaVersion: 1, ...own })))).toEqual({ digest: ownDigest, corpus: own });
  });

  it('rejects a run of the wrong length or out of range', () => {
    for (const training of [[[1, 2, 3]], [Array<number>(128).fill(356)]]) {
      const broken = { ...own, models: [{ ...own.models[0]!, training }, ...own.models.slice(1)] };
      expect(() => parseStoredCorpus(broken)).toThrow(/synthetic-17: every run must have 128 integers in \[1, 355\]/);
    }
  });

  it('rejects input that is not a corpus', () => {
    expect(() => parseStoredCorpus(null)).toThrow(/not a stored corpus/);
    expect(() => parseStoredCorpus({})).toThrow(/not a stored corpus/);
  });
});

describe('default-bank evaluation', () => {
  const evaluate = () => evaluateDefaultBank(bank, [{ digest: ownDigest, corpus: own }, { digest: otherDigest, corpus: other }]);

  it('skips own runs and scores independent runs against the full bank and without their model', async () => {
    const results = await evaluate();
    expect(results.enrolled).toEqual([{ corpus: otherDigest, models: {
      'synthetic-17': tally({ runs: 2, correct: 2 }),
      'synthetic-150': tally({ runs: 2, wrong: { 'synthetic-17': 2 } }),
    } }]);
    expect(results.labelRemoved).toEqual([{ corpus: otherDigest, models: {
      'synthetic-17': tally({ runs: 2, unknown: 2 }),
      'synthetic-150': tally({ runs: 2, wrong: { 'synthetic-17': 2 } }),
    } }]);
  });

  it("scores never-enrolled models from every corpus, including a bank's own", async () => {
    expect((await evaluate()).neverEnrolled).toEqual([
      { corpus: ownDigest, models: { 'synthetic-200': tally({ runs: 5, unknown: 5 }) } },
      { corpus: otherDigest, models: { 'synthetic-200': tally({ runs: 2, unknown: 2 }) } },
    ]);
  });
});

const enrollment = syntheticEnrollment(); // synthetic-1-120, synthetic-118-237, synthetic-236-355
const pooledOwn: StoredCorpus = {
  collectedAt: '2026-01-01T00:00:00.000Z', protocol: enrollment.protocol, checkpoints: [64],
  models: enrollment.models.map(({ id, training, validation }) => ({ id, training, validation })),
};
const pooledOwnDigest = corpusDigest(pooledOwn);
const pooled = (pass: boolean[]) => forceCutoffs(openEnvelopes(createPooledBank({
  ...enrollment, source: `SYNTHETIC POOLED TEST FIXTURE; corpus sha256:${pooledOwnDigest}; no real model measurements`, requestsPerProbe: 4,
})), pass);
const draws = (low: number, high: number, seed: number, count: number) => Array.from({ length: count }, (_, i) => syntheticRun(low, high, seed + i));
const fresh: StoredCorpus = { collectedAt: '2026-01-03T00:00:00.000Z', protocol: enrollment.protocol, checkpoints: [64], models: [
  { id: 'synthetic-1-120', training: draws(1, 120, 900, 8), validation: [] },
  { id: 'synthetic-118-237', training: draws(118, 237, 920, 8), validation: [] },
  // Fewer runs than one probe needs.
  { id: 'synthetic-236-355', training: draws(236, 355, 940, 3), validation: [] },
  { id: 'synthetic-never', training: draws(1, 355, 960, 8), validation: [] },
] };
const freshDigest = corpusDigest(fresh);
const sets = (fields: Partial<SetTally>): SetTally => ({ probes: 0, correct: 0, wrong: {}, several: 0, none: 0, stopped: 0, ...fields });

describe('pooled-bank evaluation', () => {
  const corpora = [{ digest: pooledOwnDigest, corpus: pooledOwn }, { digest: freshDigest, corpus: fresh }];

  it('groupRuns partitions runs into full-size probes, reproducibly', () => {
    expect(groupRuns(40, 8, 0)).toHaveLength(5);
    expect(groupRuns(40, 8, 0)[0]).toEqual([0, 5, 10, 15, 20, 25, 30, 35]);
    for (const grouping of [0, 1, 9]) {
      const groups = groupRuns(41, 8, grouping);
      expect(groups).toHaveLength(5);
      expect(groups.every((group) => group.length === 8)).toBe(true);
      expect(new Set(groups.flat()).size).toBe(40);
    }
    expect(groupRuns(7, 8, 0)).toEqual([]);
    expect(groupRuns(40, 8, 3)).toEqual(groupRuns(40, 8, 3));
    expect(groupRuns(40, 8, 1)).not.toEqual(groupRuns(40, 8, 0));
  });

  it('names the only candidate, skipping own runs and models with too few runs', async () => {
    expect(await evaluatePooledBank(pooled([true, false, false]), corpora, 2)).toEqual({
      groupings: 2, requestsPerProbe: 4,
      enrolled: [{ corpus: freshDigest, models: {
        'synthetic-1-120': sets({ probes: 4, correct: 4 }),
        'synthetic-118-237': sets({ probes: 4, wrong: { 'synthetic-1-120': 4 } }),
      } }],
      neverEnrolled: [{ corpus: freshDigest, models: { 'synthetic-never': sets({ probes: 4, wrong: { 'synthetic-1-120': 4 } }) } }],
    });
  });

  it('counts several candidates and empty sets', async () => {
    expect((await evaluatePooledBank(pooled([true, true, false]), corpora, 2)).enrolled[0]!.models['synthetic-1-120']).toEqual(sets({ probes: 4, several: 4 }));
    expect((await evaluatePooledBank(pooled([false, false, false]), corpora, 2)).enrolled[0]!.models['synthetic-1-120']).toEqual(sets({ probes: 4, none: 4 }));
  });

  it('counts a probe stopped by a repeated reply apart from an empty set', async () => {
    const repeated: StoredCorpus = { ...fresh, models: [{ id: 'synthetic-1-120', training: Array.from({ length: 4 }, () => syntheticRun(1, 120, 990)), validation: [] }] };
    const results = await evaluatePooledBank(pooled([true, false, false]), [{ digest: corpusDigest(repeated), corpus: repeated }], 2);
    expect(results.enrolled[0]!.models['synthetic-1-120']).toEqual(sets({ probes: 2, stopped: 2 }));
  });

  it('rejects a bank without pooled scoring', async () => {
    await expect(evaluatePooledBank(bank, [], 2)).rejects.toThrow(/needs a pooled bank/);
  });
});
