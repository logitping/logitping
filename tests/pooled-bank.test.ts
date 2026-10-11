import { describe, expect, it } from 'vitest';
import type { FingerprintBank } from '../src/core/types.js';
import { pooledBank, validateBank } from '../src/data/bank_loader.js';
import { createFingerprintBank } from '../src/data/enrollment.js';
import { createPooledBank, prepareCalibration, type PooledEnrollmentInput } from '../src/data/pooled_enrollment.js';
import { countEvents, FAMILY_SIZES, logLikelihoods } from '../src/math/pooled_features.js';
import { syntheticEnrollment, syntheticPooledBank, uniformPooledBank } from './fixtures.js';

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
    ['a pooled model without an id', (bank) => { delete (bank.pooled!.models[0] as { id?: string }).id; }],
    ['pooled models out of bank order', (bank) => { bank.pooled!.models.reverse(); }],
    ['a missing pair', (bank) => { bank.pooled!.pairs.pop(); }],
    ['a duplicate pair', (bank) => { bank.pooled!.pairs[1] = structuredClone(bank.pooled!.pairs[0]!); }],
    ['a model paired with itself', (bank) => { bank.pooled!.pairs[0]!.competitor = bank.pooled!.pairs[0]!.model; }],
    ['a negative weight', (bank) => { bank.pooled!.pairs[0]!.weights[0] = -1; }],
    ['a non-finite weight', (bank) => { bank.pooled!.pairs[0]!.weights[0] = Infinity; }],
    ['a zero scale', (bank) => { bank.pooled!.pairs[0]!.scale = 0; }],
  ])('rejects %s', (_name, mutate) => {
    const bank = uniformPooledBank();
    mutate(bank);
    expect(thrown(() => validateBank(bank))).toMatchObject({ code: 'INVALID_BANK' });
  });
});

describe('pooled enrollment', () => {
  it('extends the v1 bank of the same runs with a seeded, repeatable pooled section', () => {
    const bank = syntheticPooledBank();
    expect(JSON.stringify(syntheticPooledBank())).toBe(JSON.stringify(bank));
    expect(bank).toMatchObject({
      schemaVersion: 2,
      protocol: { id: 'integer-v1', targetSamples: 64, requestsPerProbe: 4, scoring: 'pooled-sets-v1' },
      pooled: { alpha: 0.2, bootstrap: { draws: 2000, seed: 20261011 } },
    });
    expect(bank.pooled!.pairs).toHaveLength(6);
    expect(bank.pooled!.models.map((model) => model.id)).toEqual(bank.models.map((model) => model.id));
    expect(bank.pooled!.models.map((model) => model.families.map((family) => family.length))).toEqual(Array(3).fill([...FAMILY_SIZES]));
    const v1 = createFingerprintBank(syntheticEnrollment());
    expect(bank.models).toEqual(v1.models);
    expect(bank.calibration).toEqual(v1.calibration);
  });

  it('records a custom seed, which changes only the cutoffs', () => {
    const custom = createPooledBank({ ...syntheticEnrollment(), requestsPerProbe: 4, seed: 7 });
    const standard = syntheticPooledBank();
    expect(custom.pooled!.bootstrap.seed).toBe(7);
    expect(custom.pooled!.models.map((model) => model.cutoffs)).not.toEqual(standard.pooled!.models.map((model) => model.cutoffs));
    expect(custom.pooled!.pairs).toEqual(standard.pooled!.pairs);
  });

  it('scores each calibration run with statistics fitted without it', () => {
    const events = syntheticEnrollment().models.map((model) => [...model.training, ...model.validation].map((run) => countEvents(run)));
    const calibration = prepareCalibration(events);
    const inSample = logLikelihoods(events[0]![0]!, calibration.totals[0]!).reduce((sum, value) => sum + value, 0);
    const [first] = calibration.components(0);
    expect(first!.fit).toBeLessThan(inSample);
    expect(first!.margins).toHaveLength(2);
  });

  it.each<[string, (input: PooledEnrollmentInput) => void, string]>([
    ['one model', (input) => { input.models.length = 1; }, 'at least two models'],
    ['a run of the wrong length', (input) => { input.models[0]!.validation[0] = input.models[0]!.validation[0]!.slice(1); }, 'target sample budget'],
    ['one request per probe', (input) => { input.requestsPerProbe = 1; }, 'requestsPerProbe'],
    ['a negative seed', (input) => { input.seed = -1; }, 'seed'],
  ])('rejects %s', (_name, mutate, message) => {
    const input: PooledEnrollmentInput = { ...syntheticEnrollment(), requestsPerProbe: 4 };
    mutate(input);
    expect(() => createPooledBank(input)).toThrow(message);
  });
});

describe('bundled pooled bank', () => {
  it('loads a validated 13-model bank of 8 requests × 64 integers', async () => {
    const bank = await pooledBank();
    expect(bank).toMatchObject({
      schemaVersion: 2,
      protocol: { id: 'integer-v1', language: 'en', targetSamples: 64, temperature: null, transport: 'api', requestsPerProbe: 8, scoring: 'pooled-sets-v1' },
      pooled: { alpha: 0.2, bootstrap: { draws: 2000, seed: 20261011 } },
    });
    expect(bank.models).toHaveLength(13);
    expect(bank.pooled!.pairs).toHaveLength(156);
    expect(bank.pooled!.models.map((model) => model.id)).toEqual(bank.models.map((model) => model.id));
    for (const model of bank.models) expect(model.provenance).toContain('corpus sha256:4d34afe7497e9d0d83238136885022a808a5c0e6ecfcfc32b7ed5689131f0bbf;');
  });

  it('returns an independent copy', async () => {
    const bank = await pooledBank();
    bank.pooled!.models[0]!.cutoffs.fit = 0;
    expect((await pooledBank()).pooled!.models[0]!.cutoffs.fit).not.toBe(0);
  });
});
