import { describe, expect, it } from 'vitest';
import { deriveClaimRates, wilsonInterval } from '../src/core/claim.js';
import { LogitpingError } from '../src/core/errors.js';
import { bundledClaimRates, validateClaimRates, type ClaimCounts, type ClaimRow } from '../src/data/claim_rates.js';

const row = (model: string, population: ClaimRow['population'], accepted: number, runs: number): ClaimRow => ({ model, population, accepted, runs });

describe('Wilson score intervals', () => {
  it('bounds a rate at 95%', () => {
    expect(wilsonInterval(5, 5).low).toBeCloseTo(0.5655, 3);
    expect(wilsonInterval(5, 5).high).toBe(1);
    expect(wilsonInterval(0, 5).low).toBe(0);
    expect(wilsonInterval(0, 5).high).toBeCloseTo(0.4345, 3);
    expect(wilsonInterval(15, 40).low).toBeCloseTo(0.2422, 3);
    expect(wilsonInterval(15, 40).high).toBeCloseTo(0.5297, 3);
  });

  it('spans everything without runs', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe('derived claim rates', () => {
  const counts: ClaimCounts = {
    own: { source: 'tuning', accepted: 5, runs: 5 },
    runs: [row('a', 'enrolled', 3, 4), row('b', 'enrolled', 0, 2), row('a', 'removed', 4, 4), row('b', 'removed', 1, 2), row('u', 'unenrolled', 5, 5), row('v', 'unenrolled', 1, 3)],
  };

  it('pools other enrolled runs, and outside runs from removed and unenrolled models', () => {
    const rates = deriveClaimRates(counts);
    expect(rates.own).toEqual({ source: 'tuning', accepted: 5, runs: 5, ...wilsonInterval(5, 5) });
    expect(rates.enrolled).toEqual({ accepted: 3, runs: 6, ...wilsonInterval(3, 6) });
    expect(rates.outside).toEqual({ accepted: 11, runs: 14, ...wilsonInterval(11, 14) });
  });

  it('lists models accepted in at least half their runs, without the removed simulation', () => {
    expect(deriveClaimRates(counts).mostAccepted).toEqual([
      { model: 'u', enrolled: false, accepted: 5, runs: 5 }, { model: 'a', enrolled: true, accepted: 3, runs: 4 },
    ]);
  });

  it('orders equal rates by runs, then by id', () => {
    const rates = deriveClaimRates({ own: counts.own, runs: [row('c', 'enrolled', 2, 2), row('d', 'enrolled', 4, 4), row('e', 'enrolled', 4, 4)] });
    expect(rates.mostAccepted.map((entry) => entry.model)).toEqual(['d', 'e', 'c']);
  });
});

describe('claim rate files', () => {
  const valid = () => ({
    schemaVersion: 1,
    bank: { file: 'src/data/default_bank.json', sha256: 'a'.repeat(64) },
    corpora: ['1'.repeat(64), 'b'.repeat(64)],
    rule: 'claimed model in candidates',
    claims: {
      'model-a': {
        own: { source: 'independent', accepted: 9, runs: 10 },
        runs: [row('model-b', 'enrolled', 1, 5), row('model-c', 'enrolled', 0, 5), row('model-b', 'removed', 2, 5), row('model-z', 'unenrolled', 0, 7)],
      },
    },
  });
  type File = ReturnType<typeof valid>;
  const invalid = (change: (file: File) => void) => {
    const file = valid();
    change(file);
    return file;
  };

  it('accepts a valid file and returns a copy', () => {
    const file = valid();
    const parsed = validateClaimRates(file);
    expect(parsed).toEqual(file);
    expect(parsed).not.toBe(file);
  });

  it.each([
    ['another schema version', (file: File) => { file.schemaVersion = 2; }],
    ['a short bank digest', (file: File) => { file.bank.sha256 = 'a'.repeat(63); }],
    ['unsorted corpora', (file: File) => { file.corpora.reverse(); }],
    ['another rule', (file: File) => { file.rule = 'model identified'; }],
    ['more accepted than runs', (file: File) => { file.claims['model-a'].runs[0]!.accepted = 6; }],
    ['a row without runs', (file: File) => { file.claims['model-a'].runs[0]!.runs = 0; }],
    ['a fractional count', (file: File) => { file.claims['model-a'].runs[0]!.accepted = 1.5; }],
    ['an unknown population', (file: File) => { (file.claims['model-a'].runs[0] as { population: string }).population = 'other'; }],
    ['rows out of order', (file: File) => { file.claims['model-a'].runs.reverse(); }],
    ['a duplicate row', (file: File) => { file.claims['model-a'].runs.splice(1, 0, { ...file.claims['model-a'].runs[0]! }); }],
    ['a row naming its own claim', (file: File) => { file.claims['model-a'].runs[0]!.model = 'model-a'; }],
    ['an unknown own source', (file: File) => { file.claims['model-a'].own.source = 'mixed'; }],
    ['own counts without runs', (file: File) => { file.claims['model-a'].own = { source: 'tuning', accepted: 0, runs: 0 }; }],
    ['an invalid claim id', (file: File) => { (file.claims as Record<string, unknown>)['bad id'] = file.claims['model-a']; }],
  ])('rejects %s', (_name, change) => {
    let code: string | undefined;
    try { validateClaimRates(invalid(change)); } catch (error) { code = error instanceof LogitpingError ? error.code : 'not a LogitpingError'; }
    expect(code).toBe('INVALID_BANK');
  });

  it('serves the bundled file for the default bank', () => {
    expect(bundledClaimRates().bank.file).toBe('src/data/default_bank.json');
  });
});
