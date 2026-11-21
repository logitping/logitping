import { describe, expect, it } from 'vitest';
import { createFingerprintBank } from '../src/data/enrollment.js';
import { evaluateDefaultBank, parseStoredCorpus, type StatusTally, type StoredCorpus } from '../src/data/evaluation.js';
import { corpusDigest } from '../src/data/gateway_plan.js';

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
