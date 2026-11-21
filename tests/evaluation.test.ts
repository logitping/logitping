import { describe, expect, it } from 'vitest';
import { createFingerprintBank } from '../src/data/enrollment.js';
import {
  evaluateBanks, evaluateClaimCounts, evaluateDefaultBank, evaluatePooledBank, groupRuns, parseStoredCorpus, renderEvaluationReport, sha256,
  type EvaluationReport, type SetTally, type StatusTally, type StoredCorpus,
} from '../src/data/evaluation.js';
import type { ClaimRatesFile } from '../src/data/claim_rates.js';
import { corpusDigest } from '../src/data/gateway_plan.js';
import { createPooledBank } from '../src/data/pooled_enrollment.js';
import { forceCutoffs, openEnvelopes, overlappingBank, syntheticEnrollment, syntheticRun } from './fixtures.js';

const PROTOCOL = { id: 'integer-v1', language: 'en', targetSamples: 128, temperature: null, transport: 'openai' } as const;
const constant = (value: number, count: number) => Array.from({ length: count }, () => Array<number>(128).fill(value));
const model = (id: string, value: number, training: number, validation = 0) => ({ id, training: constant(value, training), validation: constant(value, validation) });
const corpus = (collectedAt: string, models: StoredCorpus['models']): StoredCorpus => ({ collectedAt, protocol: { ...PROTOCOL }, checkpoints: [64, 128], models });
const tally = (fields: Partial<StatusTally>): StatusTally => ({ runs: 0, correct: 0, wrong: {}, inconclusive: 0, unknown: 0, listed: 0, empty: 0, candidateCount: 0, multiVendor: 0, ...fields });

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
      'synthetic-17': tally({ runs: 2, correct: 2, listed: 2, candidateCount: 2 }),
      'synthetic-150': tally({ runs: 2, wrong: { 'synthetic-17': 2 }, candidateCount: 2 }),
    } }]);
    expect(results.labelRemoved).toEqual([{ corpus: otherDigest, models: {
      'synthetic-17': tally({ runs: 2, unknown: 2, empty: 2 }),
      'synthetic-150': tally({ runs: 2, wrong: { 'synthetic-17': 2 }, candidateCount: 2 }),
    } }]);
  });

  it("scores an enrolled model whose references name another corpus, inside a bank's own corpus", async () => {
    // As in corpus 163709a6: the bank's own for some models, independent for another enrolled model.
    const mixed = { ...bank, models: bank.models.map((entry) => entry.id !== 'synthetic-150' ? entry
      : { ...entry, provenance: `SYNTHETIC TEST FIXTURE; corpus sha256:${'0'.repeat(64)}; no real model measurements` }) };
    const results = await evaluateDefaultBank(mixed, [{ digest: ownDigest, corpus: own }]);
    expect(results.enrolled).toEqual([{ corpus: ownDigest, models: { 'synthetic-150': tally({ runs: 5, correct: 5, listed: 5, candidateCount: 5 }) } }]);
    expect(results.labelRemoved).toEqual([{ corpus: ownDigest, models: { 'synthetic-150': tally({ runs: 5, unknown: 5, empty: 5 }) } }]);
  });

  it('counts candidate lists that span several vendors', async () => {
    // overlappingBank's model-a and model-b, of different families, both stay within the naming threshold.
    const tens = corpus('2026-01-04T00:00:00.000Z', [{ id: 'model-a', training: [Array<number>(128).fill(10), Array<number>(128).fill(10)], validation: [] }]);
    const results = await evaluateDefaultBank(overlappingBank(), [{ digest: corpusDigest(tens), corpus: tens }]);
    expect(results.enrolled[0]!.models['model-a']).toEqual(tally({ runs: 2, inconclusive: 2, listed: 2, candidateCount: 4, multiVendor: 2 }));
  });

  it("scores never-enrolled models from every corpus, including a bank's own", async () => {
    expect((await evaluate()).neverEnrolled).toEqual([
      { corpus: ownDigest, models: { 'synthetic-200': tally({ runs: 5, unknown: 5, empty: 5 }) } },
      { corpus: otherDigest, models: { 'synthetic-200': tally({ runs: 2, unknown: 2, empty: 2 }) } },
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
const sets = (fields: Partial<SetTally>): SetTally => ({ probes: 0, correct: 0, wrong: {}, several: 0, none: 0, stopped: 0, listed: 0, ...fields });

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
        'synthetic-1-120': sets({ probes: 4, correct: 4, listed: 4 }),
        'synthetic-118-237': sets({ probes: 4, wrong: { 'synthetic-1-120': 4 } }),
      } }],
      neverEnrolled: [{ corpus: freshDigest, models: { 'synthetic-never': sets({ probes: 4, wrong: { 'synthetic-1-120': 4 } }) } }],
    });
  });

  it('counts several candidates and empty sets', async () => {
    expect((await evaluatePooledBank(pooled([true, true, false]), corpora, 2)).enrolled[0]!.models['synthetic-1-120']).toEqual(sets({ probes: 4, several: 4, listed: 4 }));
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

const input = (corpora: unknown[]) => ({
  default: { file: 'src/data/default_bank.json', text: JSON.stringify(bank) },
  pooled: { file: 'src/data/pooled_bank.json', text: JSON.stringify(pooled([true, false, false])) },
  corpora,
});

describe('claim counts', () => {
  const counts = () => evaluateClaimCounts(bank, [{ digest: ownDigest, corpus: own }, { digest: otherDigest, corpus: other }]);

  it('has one claim per enrolled model, in bank order', async () => {
    expect(Object.keys(await counts())).toEqual(['synthetic-17', 'synthetic-150', 'synthetic-287']);
  });

  it("measures a claim on the model's independent runs, or else its tuning runs", async () => {
    const claims = await counts();
    expect(claims['synthetic-17']!.own).toEqual({ source: 'independent', accepted: 2, runs: 2 });
    // synthetic-150's independent runs are mislabeled 17s.
    expect(claims['synthetic-150']!.own).toEqual({ source: 'independent', accepted: 0, runs: 2 });
    expect(claims['synthetic-287']!.own).toEqual({ source: 'tuning', accepted: 2, runs: 2 });
  });

  it("counts other enrolled models' independent and tuning runs, with and without their reference", async () => {
    const rows = (await counts())['synthetic-17']!.runs;
    expect(rows).toEqual([
      { model: 'synthetic-150', population: 'enrolled', accepted: 2, runs: 4 },
      { model: 'synthetic-287', population: 'enrolled', accepted: 0, runs: 2 },
      { model: 'synthetic-150', population: 'removed', accepted: 2, runs: 4 },
      { model: 'synthetic-287', population: 'removed', accepted: 0, runs: 2 },
      { model: 'synthetic-200', population: 'unenrolled', accepted: 0, runs: 7 },
    ]);
  });

  it('counts every run of unenrolled models and no row for the claim itself', async () => {
    for (const [id, claim] of Object.entries(await counts())) {
      expect(claim.runs.find((row) => row.population === 'unenrolled')).toEqual({ model: 'synthetic-200', population: 'unenrolled', accepted: 0, runs: 7 });
      expect(claim.runs.some((row) => row.model === id)).toBe(false);
    }
  });
});

describe('evaluation report', () => {
  it('writes the claim file for the default bank and the corpora it scored', async () => {
    const { claims } = await evaluateBanks(input([other, own, fresh]));
    expect(claims).toMatchObject({
      schemaVersion: 1, bank: { file: 'src/data/default_bank.json', sha256: sha256(JSON.stringify(bank)) },
      corpora: [ownDigest, otherDigest].sort(), rule: 'claimed model in candidates',
    });
    expect(Object.keys(claims.claims)).toEqual(['synthetic-17', 'synthetic-150', 'synthetic-287']);
  });

  it('records both banks by file and SHA-256, and corpora in collection order', async () => {
    const { report } = await evaluateBanks(input([other, own, fresh]));
    expect(report.schemaVersion).toBe(2);
    expect(report.banks.default).toEqual({ file: 'src/data/default_bank.json', sha256: sha256(JSON.stringify(bank)), models: 3 });
    expect(report.corpora.map((entry) => entry.sha256)).toEqual([ownDigest, otherDigest, freshDigest]);
    expect(report.corpora[0]).toEqual({
      sha256: ownDigest, collectedAt: own.collectedAt, targetSamples: 128, models: ['synthetic-17', 'synthetic-150', 'synthetic-287', 'synthetic-200'],
    });
    expect(report.default.enrolled[0]!.corpus).toBe(otherDigest);
    expect(report.pooled.neverEnrolled[0]!.corpus).toBe(freshDigest);
    expect(report.pooled.groupings).toBe(10);
  });

  it('reads a copied corpus once', async () => {
    expect(await evaluateBanks(input([own, other, structuredClone(other)]))).toEqual(await evaluateBanks(input([own, other])));
  });

  it('refuses a corpus that matches neither bank', async () => {
    await expect(evaluateBanks(input([{ ...other, protocol: { ...other.protocol, language: 'zh' } }]))).rejects.toThrow(/matches neither bank/);
  });

  it("refuses claim counts for a model without any stored run of its own", async () => {
    await expect(evaluateBanks(input([other]))).rejects.toThrow('No stored runs of synthetic-287 measure its own claim');
  });

  it('refuses to run without corpora', async () => {
    await expect(evaluateBanks(input([]))).rejects.toThrow(/No stored corpora/);
  });

  it('refuses a bank file that is not a valid bank', async () => {
    await expect(evaluateBanks({ ...input([other]), default: { file: 'src/data/default_bank.json', text: '{}' } })).rejects.toThrow(/Invalid bank/);
  });
});

describe('rendered report', () => {
  const C = 'c'.repeat(64);
  const report: EvaluationReport = {
    schemaVersion: 2,
    banks: { default: { file: 'src/data/default_bank.json', sha256: 'a'.repeat(64), models: 2 }, pooled: { file: 'src/data/pooled_bank.json', sha256: 'b'.repeat(64), models: 2 } },
    corpora: [{ sha256: C, collectedAt: '2026-10-11T02:51:23.401Z', targetSamples: 512, models: ['m1', 'm2'] }],
    default: {
      enrolled: [{ corpus: C, models: { m1: { runs: 3, correct: 1, wrong: { m3: 1, m2: 1 }, inconclusive: 1, unknown: 0, listed: 2, empty: 0, candidateCount: 5, multiVendor: 1 } } }],
      labelRemoved: [{ corpus: C, models: { m1: { runs: 3, correct: 0, wrong: { m2: 2 }, inconclusive: 0, unknown: 1, listed: 0, empty: 1, candidateCount: 4, multiVendor: 0 } } }],
      neverEnrolled: [],
    },
    pooled: {
      groupings: 10, requestsPerProbe: 8, enrolled: [],
      neverEnrolled: [{ corpus: C, models: { m9: { probes: 50, correct: 0, wrong: { m1: 3 }, several: 0, none: 47, stopped: 0, listed: 0 } } }],
    },
  };
  const claims: ClaimRatesFile = {
    schemaVersion: 1, bank: { file: 'src/data/default_bank.json', sha256: 'a'.repeat(64) }, corpora: [C], rule: 'claimed model in candidates',
    claims: {
      m1: { own: { source: 'independent', accepted: 3, runs: 3 }, runs: [
        { model: 'm2', population: 'enrolled', accepted: 2, runs: 4 }, { model: 'm2', population: 'removed', accepted: 3, runs: 4 },
        { model: 'm9', population: 'unenrolled', accepted: 5, runs: 5 },
      ] },
      m2: { own: { source: 'tuning', accepted: 2, runs: 2 }, runs: [{ model: 'm1', population: 'enrolled', accepted: 0, runs: 3 }] },
    },
  };
  const markdown = renderEvaluationReport(report, claims);

  it('starts with its title and ends with one newline', () => {
    expect(markdown.startsWith('# Independent evaluation\n')).toBe(true);
    expect(markdown.endsWith('\n')).toBe(true);
    expect(markdown.endsWith('\n\n')).toBe(false);
  });

  it('writes the bank, corpus, per-model and total rows', () => {
    const lines = markdown.split('\n');
    for (const line of [
      '| Default | `src/data/default_bank.json` | `' + 'a'.repeat(64) + '` | 2 |',
      '| `cccccccccccc` | 2026-10-11 | 512 | m1, m2 |',
      '| `cccccccccccc` | m1 | 3 | 1 | 2 (m2 1, m3 1) | 1 | 0 | 2 | 1.7 | 1 |',
      '| **Total** | | 3 | 1 | 2 (m2 1, m3 1) | 1 | 0 | 2 | 1.7 | 1 |',
      '| `cccccccccccc` | m1 | 3 | 2 (m2 2) | 0 | 1 | 1 | 1.3 | 0 |',
      '| `cccccccccccc` | m9 | 50 | 3 (m1 3) | 0 | 47 | 0 |',
    ]) expect(lines).toContain(line);
  });

  it('writes one claim row per claimed model, after the default bank', () => {
    const lines = markdown.split('\n');
    expect(lines).toContain('| m1 | 3/3 (44–100%) | 2/4 (50%) | 8/9 (89%) | m9 (not enrolled) 5/5, m2 2/4 |');
    expect(lines).toContain('| m2 | 2/2 (tuning; 34–100%) | 0/3 (0%) | No runs | None |');
    expect(markdown.indexOf('## Claims')).toBeGreaterThan(markdown.indexOf('## Default bank'));
    expect(markdown.indexOf('## Claims')).toBeLessThan(markdown.indexOf('## Pooled bank'));
  });

  it('prints No runs. for an empty section', () => {
    expect(markdown).toContain('### Models the bank does not enroll\n\nNo runs.\n');
    expect(markdown).not.toContain('never enrolled');
  });
});
