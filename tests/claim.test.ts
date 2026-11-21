import { describe, expect, it, vi } from 'vitest';
import { deriveClaimRates } from '../src/core/claim.js';
import { fingerprint } from '../src/core/engine.js';
import type { FingerprintBank } from '../src/core/types.js';
import * as bankLoader from '../src/data/bank_loader.js';
import * as claimRates from '../src/data/claim_rates.js';
import { collectionSettingsFor } from '../src/data/collection_settings.js';
import { collectionBank, MemoryTransport, overlappingBank, SequenceTransport, syntheticBank, syntheticPooledBank, syntheticRun, uncalibratedBank } from './fixtures.js';

const reply = (value: number, count = 128) => new MemoryTransport([`${Array<number>(count).fill(value).join(' ')} `]);
const probe = async (bank: FingerprintBank, transport: MemoryTransport, claim?: string) =>
  (await fingerprint(transport, { bank, ...(claim !== undefined ? { claim } : {}) })).claim;

describe('claim verdicts', () => {
  it('accepts a claim the probe identified, matching the last path segment without case', async () => {
    expect(await probe(syntheticBank(), reply(17), 'vendor/SYNTHETIC-17')).toEqual({
      requested: 'vendor/SYNTHETIC-17', model: 'synthetic-17', verdict: 'CONSISTENT', reason: 'The probe identified synthetic-17.', rates: null,
    });
  });

  it('rejects a claim when the probe identified another model', async () => {
    expect(await probe(syntheticBank(), reply(17), 'synthetic-287')).toMatchObject({
      model: 'synthetic-287', verdict: 'INCONSISTENT', reason: 'The probe identified synthetic-17 instead.', rates: null,
    });
  });

  it('rejects every claim when no enrolled model fits', async () => {
    const transport = reply(200);
    const result = await fingerprint(transport, { bank: syntheticBank(), claim: 'synthetic-17' });
    expect(result.status).toBe('UNKNOWN_MODEL');
    expect(result.claim).toMatchObject({ verdict: 'INCONSISTENT', reason: 'synthetic-17 is not among the candidates; no enrolled model fits this probe.' });
  });

  it('checks a claim against the candidates of an inconclusive probe', async () => {
    expect(await probe(overlappingBank(), reply(10), 'model-b')).toMatchObject({ verdict: 'CONSISTENT', reason: 'model-b is among the 2 candidates.' });
    expect(await probe(overlappingBank(), reply(10), 'model-c')).toMatchObject({ verdict: 'INCONSISTENT', reason: 'model-c is not among the candidates: model-a, model-b.' });
  });

  it('does not check a claim the bank does not enroll', async () => {
    expect(await probe(syntheticBank(), reply(17), 'gpt-7')).toEqual({
      requested: 'gpt-7', model: null, verdict: 'NOT_ENROLLED', reason: 'The bank enrolls no model named gpt-7.', rates: null,
    });
    expect(await probe(syntheticBank(), reply(17), 'openai/')).toMatchObject({ model: null, verdict: 'NOT_ENROLLED' });
  });

  it('does not check a claim when a short reply leaves no candidates', async () => {
    expect(await probe(syntheticBank(), reply(17, 50), 'synthetic-17')).toMatchObject({
      verdict: 'NOT_CHECKED', reason: 'The probe computed no candidates, so the claim was not checked.',
    });
  });

  it('does not check a claim of a model enrolled without calibration', async () => {
    const bank = syntheticBank();
    bank.models.push({ ...uncalibratedBank().models[0]!, id: 'pending' });
    expect(await probe(bank, reply(17), 'pending')).toMatchObject({
      model: 'pending', verdict: 'NOT_CHECKED', reason: 'pending is enrolled without calibration, so it is never a candidate.',
    });
  });

  it('does not check a claim when a CLI driver collects with the bundled API bank', async () => {
    const result = await fingerprint(new MemoryTransport([`${Array<number>(512).fill(17).join(' ')} `], 'message', 'codex'), { claim: 'claude-opus-5' });
    expect(result.status).toBe('UNCALIBRATED');
    expect(result.claim).toMatchObject({ model: 'claude-opus-5', verdict: 'NOT_CHECKED' });
  });

  it('checks a pooled probe against its prediction set, without rates', async () => {
    const transport = new SequenceTransport([0, 1, 2, 3].map((seed) => [`${syntheticRun(1, 120, seed).join(' ')} `]));
    const result = await fingerprint(transport, { bank: syntheticPooledBank(4), claim: 'synthetic-1-120' });
    expect(result.candidates).toEqual(['synthetic-1-120']);
    expect(result.claim).toMatchObject({ verdict: 'CONSISTENT', reason: 'synthetic-1-120 is the only candidate.', rates: null });
  });

  it('reports no claim without one', async () => {
    expect(await fingerprint(reply(17), { bank: syntheticBank() })).not.toHaveProperty('claim');
    expect(await fingerprint(reply(17), { bank: syntheticBank(), claim: '' })).not.toHaveProperty('claim');
  });
});

describe('collection settings matching', () => {
  it('shares the claim matching rule', () => {
    expect(collectionSettingsFor(collectionBank(), 'VENDOR/Synthetic-17')).toMatchObject({ id: 'synthetic-17', collection: { maxTokens: 4096 } });
    expect(collectionSettingsFor(collectionBank(), 'synthetic-287')).toBeUndefined();
  });
});

describe('claim rates', () => {
  const file = (): claimRates.ClaimRatesFile => ({
    schemaVersion: 1, bank: { file: 'src/data/default_bank.json', sha256: 'a'.repeat(64) }, corpora: [], rule: 'claimed model in candidates',
    claims: {
      'synthetic-17': { own: { source: 'independent', accepted: 9, runs: 10 }, runs: [{ model: 'synthetic-287', population: 'enrolled', accepted: 1, runs: 5 }] },
      'synthetic-287': { own: { source: 'tuning', accepted: 5, runs: 5 }, runs: [{ model: 'synthetic-17', population: 'unenrolled', accepted: 0, runs: 3 }] },
    },
  });
  /** The bundled bank is the synthetic bank, measured by `rates`. */
  const bundled = (rates = file()) => {
    vi.spyOn(bankLoader, 'defaultBank').mockImplementation(syntheticBank);
    return vi.spyOn(claimRates, 'bundledClaimRates').mockImplementation(() => rates);
  };

  it('attaches the measured rates to a claim checked with the bundled bank', async () => {
    bundled();
    expect((await fingerprint(reply(17), { claim: 'synthetic-17' })).claim).toMatchObject({
      verdict: 'CONSISTENT', rates: deriveClaimRates(file().claims['synthetic-17']!),
    });
  });

  it('attaches them to an inconsistent claim too', async () => {
    bundled();
    expect((await fingerprint(reply(17), { claim: 'synthetic-287' })).claim).toMatchObject({
      verdict: 'INCONSISTENT', rates: deriveClaimRates(file().claims['synthetic-287']!),
    });
  });

  it('attaches none to a bank passed in, even one identical to the bundled bank', async () => {
    bundled();
    expect((await fingerprint(reply(17), { bank: bankLoader.defaultBank(), claim: 'synthetic-17' })).claim).toMatchObject({ verdict: 'CONSISTENT', rates: null });
  });

  it('attaches none to a cross-transport comparison', async () => {
    bundled();
    const result = await fingerprint(new MemoryTransport([`${Array<number>(128).fill(17).join(' ')} `], 'token', 'claude'), { claim: 'synthetic-17', allowTransportMismatch: true });
    expect(result.crossTransport).toBeDefined();
    expect(result.claim).toMatchObject({ verdict: 'CONSISTENT', rates: null });
  });

  it('attaches none to a claim the file does not measure', async () => {
    const rates = file();
    delete rates.claims['synthetic-287'];
    bundled(rates);
    expect((await fingerprint(reply(17), { claim: 'synthetic-287' })).claim).toMatchObject({ verdict: 'INCONSISTENT', rates: null });
  });

  it('attaches the committed counts on the real bundled bank', async () => {
    const result = await fingerprint(reply(17, 512), { claim: 'anthropic/claude-sonnet-5.5' });
    expect(result.claim).toMatchObject({
      model: 'claude-sonnet-5.5', verdict: 'INCONSISTENT', rates: deriveClaimRates(claimRates.bundledClaimRates().claims['claude-sonnet-5.5']!),
    });
  });

  it('reads the file only for a claim that needs rates', async () => {
    const read = bundled();
    await fingerprint(reply(17), {});
    await fingerprint(reply(17), { claim: 'gpt-7' });
    await fingerprint(reply(17, 50), { claim: 'synthetic-17' });
    expect(read).not.toHaveBeenCalled();
  });
});
