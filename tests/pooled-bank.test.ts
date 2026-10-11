import { describe, expect, it } from 'vitest';
import type { FingerprintBank } from '../src/core/types.js';
import { validateBank } from '../src/data/bank_loader.js';
import { uniformPooledBank } from './fixtures.js';

function thrown(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  return undefined;
}

describe('pooled bank validation', () => {
  it('accepts a schema-v2 bank and returns an independent copy', () => {
    const bank = uniformPooledBank();
    const copy = validateBank(bank);
    expect(copy).toEqual(bank);
    copy.pooled!.models[0]!.cutoffs.fit = 5;
    expect(bank.pooled!.models[0]!.cutoffs.fit).toBe(0);
  });

  it.each<[string, (bank: FingerprintBank) => void]>([
    ['schema version 2 without a pooled section', (bank) => { delete bank.pooled; }],
    ['pooled scoring under schema version 1', (bank) => { bank.schemaVersion = 1; }],
    ['an unknown schema version', (bank) => { (bank as { schemaVersion: number }).schemaVersion = 3; }],
    ['a missing scoring id', (bank) => { delete bank.protocol.scoring; }],
    ['one request per probe', (bank) => { bank.protocol.requestsPerProbe = 1; }],
    ['65 requests per probe', (bank) => { bank.protocol.requestsPerProbe = 65; }],
    ['a single model', (bank) => { bank.models.pop(); bank.pooled!.models.pop(); bank.pooled!.pairs = []; }],
    ['an uncalibrated model', (bank) => { bank.models[1]!.status = 'uncalibrated'; }],
    ['a feature group of the wrong size', (bank) => { bank.pooled!.models[0]!.families[2]!.pop(); }],
    ['an unsmoothed probability', (bank) => { const family = bank.pooled!.models[0]!.families[0]!; family[1]! += family[0]!; family[0] = 0; }],
    ['a non-finite cutoff', (bank) => { bank.pooled!.models[0]!.cutoffs.fit = Infinity; }],
    ['a missing pooled model', (bank) => { bank.pooled!.models.pop(); }],
    ['a missing pair', (bank) => { bank.pooled!.pairs.pop(); }],
    ['a duplicate pair', (bank) => { bank.pooled!.pairs[1] = structuredClone(bank.pooled!.pairs[0]!); }],
    ['a model paired with itself', (bank) => { bank.pooled!.pairs[0]!.competitor = bank.pooled!.pairs[0]!.model; }],
    ['a negative weight', (bank) => { bank.pooled!.pairs[0]!.weights[0] = -1; }],
    ['a zero scale', (bank) => { bank.pooled!.pairs[0]!.scale = 0; }],
  ])('rejects %s', (_name, mutate) => {
    const bank = uniformPooledBank();
    mutate(bank);
    expect(thrown(() => validateBank(bank))).toMatchObject({ code: 'INVALID_BANK' });
  });
});
