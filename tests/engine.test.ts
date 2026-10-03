import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fingerprint, planProbe } from '../src/core/engine.js';
import type { FingerprintBank, ProbeTransport } from '../src/core/types.js';
import { defaultBank, loadBank, validateBank } from '../src/data/bank_loader.js';
import { createFingerprintBank } from '../src/data/enrollment.js';
import * as bankLoader from '../src/data/bank_loader.js';
import { IntegerOutputError, IntegerStreamParser } from '../src/probes/integer_stream.js';
import { MemoryTransport, syntheticBank, uncalibratedBank } from './fixtures.js';

describe('strict streaming integer parser', () => {
  it('handles every chunk boundary identically', () => {
    const input = '1 355,17\n200 9';
    for (let split = 0; split <= input.length; split++) {
      const parser = new IntegerStreamParser();
      expect([...parser.push(input.slice(0, split)), ...parser.push(input.slice(split)), ...parser.finish()]).toEqual([1, 355, 17, 200, 9]);
    }
  });
  it.each(['1.5 ', '-3 ', '1e2 ', 'hello17 ', '356 ', '0 ', '003 ', '2/3 '])('rejects contaminated output %s', (text) => {
    expect(() => [...new IntegerStreamParser().push(text)]).toThrow();
  });
  it('reports the invalid integer position across chunk boundaries and at end of input', () => {
    const input = '17 355 356';
    for (let split = 0; split <= input.length; split++) {
      const parser = new IntegerStreamParser();
      try {
        [...parser.push(input.slice(0, split)), ...parser.push(input.slice(split)), ...parser.finish()];
        expect.fail('expected invalid integer output');
      } catch (error) {
        expect(error).toBeInstanceOf(IntegerOutputError);
        expect(error).toMatchObject({ position: 3, message: 'Invalid integer output at position 3: 356 is outside [1, 355]' });
      }
    }
  });
});

describe('bank validation', () => {
  it('loads a valid independent copy of the updatable default bank', () => {
    const bank = defaultBank();
    expect(validateBank(bank)).toEqual(bank);
    const probability = bank.models[0]!.integerProbabilities[0];
    bank.models[0]!.integerProbabilities[0] = 1;
    expect(defaultBank().models[0]!.integerProbabilities[0]).toBe(probability);
  });
  it('refuses dimension errors, missing provenance, and incompatible checkpoint sets', () => {
    const bank = syntheticBank();
    expect(() => validateBank({ ...bank, calibration: null })).toThrow();
    bank.models[0]!.profiles[0]!.centroid = bank.models[0]!.profiles[0]!.centroid.slice(1);
    expect(() => validateBank(bank)).toThrow();
    const another = syntheticBank();
    another.models[0]!.profiles.shift();
    expect(() => validateBank(another)).toThrow();
  });
  const unbalanced = (values: number[]) => values.map((value, i) => i === 0 ? value + 0.5 : value);
  it.each([
    ['a non-object root', () => 'bank'],
    ['an unsupported feature version', () => ({ ...syntheticBank(), featureVersion: 'ordered-9-v9' })],
    ['duplicate model ids', () => { const bank = syntheticBank(); bank.models[1]!.id = bank.models[0]!.id; return bank; }],
    ['integer probabilities that do not sum to one', () => { const bank = syntheticBank(); bank.models[0]!.integerProbabilities = unbalanced(bank.models[0]!.integerProbabilities); return bank; }],
    ['a centroid that is not a distribution', () => { const bank: FingerprintBank = syntheticBank(); bank.models[0]!.profiles[0]!.centroid = unbalanced([...bank.models[0]!.profiles[0]!.centroid]); return bank; }],
    // The sequential test accepts no decision before 64 integers, so such a bank could never identify a model.
    ['a calibrated sample budget below the sequential minimum', () => {
      const bank = syntheticBank();
      bank.protocol.targetSamples = 32;
      for (const model of bank.models) model.profiles = [{ ...model.profiles[0]!, sampleCount: 32 }];
      return bank;
    }],
  ])('reports %s as INVALID_BANK, so callers can tell bad bank data from other failures', (_label, build) => {
    expect(() => validateBank(build())).toThrow(expect.objectContaining({ name: 'LogitpingError', code: 'INVALID_BANK' }));
  });
  it('keeps small sample budgets for collection-only banks', () => {
    const bank = uncalibratedBank();
    bank.protocol.targetSamples = 4;
    expect(validateBank(bank).protocol.targetSamples).toBe(4);
  });
  it('reports an unusable bank file as INVALID_BANK and keeps file-system errors intact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'logitping-bank-'));
    try {
      const malformed = join(directory, 'bank.json');
      await writeFile(malformed, '{"schemaVersion": 1,');
      await expect(loadBank(malformed)).rejects.toMatchObject({ code: 'INVALID_BANK', message: 'Fingerprint bank is not valid JSON' });
      await expect(loadBank(directory)).rejects.toMatchObject({ code: 'INVALID_BANK', message: 'Bank must be a JSON file no larger than 16 MiB' });
      await expect(loadBank(join(directory, 'missing.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('classification pipeline', () => {
  it('aborts at the first jointly accepted calibrated checkpoint', async () => {
    const transport = new MemoryTransport(Array<string>(128).fill('17 '));
    const result = await fingerprint(transport, { bank: syntheticBank(), tokenizerProbe: false });
    expect(result.status).toBe('IDENTIFIED');
    expect(result.model).toBe('synthetic-17');
    expect(result.samples).toHaveLength(64);
    expect(result.earlyStopped).toBe(true);
    expect(result.sampleBudgetSaved).toBe(0.5);
    expect(result.confidence).toBeGreaterThan(0.995);
    expect(transport.closed && transport.aborted).toBe(true);
  });
  it('does not accept high closed-set confidence when OOD rejects it', async () => {
    const values = [...Array<string>(12).fill('17 '), ...Array<string>(116).fill('100 ')];
    const result = await fingerprint(new MemoryTransport(values), { bank: syntheticBank(), tokenizerProbe: false });
    expect(result.status).toBe('UNKNOWN_MODEL');
    expect(result.confidence).toBeNull();
    expect(result.scores.every((score) => score.weight === null)).toBe(true);
    expect(result.earlyStopped).toBe(false);
  });
  it('supports full-budget testing and refuses message-level savings claims', async () => {
    for (const granularity of ['token', 'message'] as const) {
      const result = await fingerprint(new MemoryTransport(['17 '.repeat(128)], granularity), {
        bank: syntheticBank(), tokenizerProbe: false, earlyStopping: false,
      });
      expect(result.samples).toHaveLength(128);
      expect(result.earlyStopped).toBe(false);
    }
    const result = await fingerprint(new MemoryTransport(['17 '.repeat(128)], 'message'), { bank: syntheticBank(), tokenizerProbe: false });
    expect(result.samples).toHaveLength(128);
    expect(result.sampleBudgetSaved).toBe(0);
  });
  it('disables early stopping without sequential validation', async () => {
    const bank = syntheticBank();
    bank.calibration!.sequentialValidated = false;
    const result = await fingerprint(new MemoryTransport(['17 '.repeat(128)]), { bank, tokenizerProbe: false });
    expect(result.samples).toHaveLength(128);
  });
  it('never identifies a model from uncalibrated priors', async () => {
    const result = await fingerprint(new MemoryTransport(['1 2 3 4']), { bank: uncalibratedBank(), samples: 4, tokenizerProbe: false });
    expect(result.status).toBe('UNCALIBRATED');
    expect(result.model).toBeNull();
    expect(result.scores).toEqual([]);
  });
  it.each([false, true])('does not identify from a reply that ends at a calibrated checkpoint (validated=%s)', async (validated) => {
    const bank = syntheticBank();
    bank.calibration!.sequentialValidated = validated;
    const result = await fingerprint(new MemoryTransport(['17 '.repeat(64)], 'message'), { bank });
    expect(result).toMatchObject({ status: 'INCONCLUSIVE', model: null, confidence: null, scores: [], evaluatedSamples: 0, earlyStopped: false });
    expect(result.reason).toContain('response ended after 64');
    expect(result.reason).toContain('704-token output limit');
    expect(result.warnings.join(' ')).toContain('The response ended after 64 of 128 requested integers (output limit: 704 tokens).');
  });
  it('does not use a different sample-size threshold on short responses', async () => {
    const result = await fingerprint(new MemoryTransport(['17 '.repeat(70)]), { bank: syntheticBank(), tokenizerProbe: false, earlyStopping: false });
    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.evaluatedSamples).toBe(0);
  });
  it('fails protocol mismatches before contacting the endpoint', async () => {
    const transport = new MemoryTransport(['17 '.repeat(128)]);
    await expect(fingerprint(transport, { bank: syntheticBank(), samples: 100 })).rejects.toThrow('samples=100 (bank: 128)');
    await expect(fingerprint(transport, { bank: syntheticBank(), language: 'zh' })).rejects.toThrow('language=zh (bank: en)');
    await expect(fingerprint(transport, { bank: syntheticBank(), temperature: 0.5 })).rejects.toThrow('temperature=0.5 (bank: null)');
    expect(transport.requests).toHaveLength(0);
  });
  it.each(['codex', 'claude', 'anthropic'])('collects without API calibration when %s uses the implicit default bank', async (name) => {
    const bank = syntheticBank();
    bank.protocol.temperature = 0.7;
    const original = structuredClone(bank);
    vi.spyOn(bankLoader, 'defaultBank').mockReturnValue(bank);
    const transport = new MemoryTransport(['17 '.repeat(128)], name === 'codex' ? 'message' : 'token', name);
    const result = await fingerprint(transport, { tokenizerProbe: false });
    expect(result).toMatchObject({
      status: 'UNCALIBRATED', model: null, confidence: null, scores: [], evaluatedSamples: 0,
      earlyStopped: false, sampleBudgetSaved: 0,
    });
    expect(result.reason).toContain(`No calibrated bank for ${name}`);
    expect(result.warnings.join(' ')).toContain(`enrolled through ${name}`);
    expect(result.warnings.join(' ')).not.toContain('uniform priors');
    expect(result.samples).toHaveLength(128);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]!.temperature).toBeUndefined();
    expect(bank).toEqual(original);
  });
  it('allows a different sample budget for collection with an incompatible implicit bank', async () => {
    vi.spyOn(bankLoader, 'defaultBank').mockReturnValue(syntheticBank());
    const result = await fingerprint(new MemoryTransport(['1 2 3 4'], 'message', 'codex'), {
      samples: 4, language: 'zh', tokenizerProbe: false,
    });
    expect(result.status).toBe('UNCALIBRATED');
    expect(result.samples).toEqual([1, 2, 3, 4]);
  });
  it.each(['codex', 'claude', 'anthropic'])('rejects an explicitly supplied bank for a different transport before calling %s', async (name) => {
    const transport = new MemoryTransport(['17 '.repeat(128)], 'message', name);
    await expect(fingerprint(transport, { bank: syntheticBank(), tokenizerProbe: false }))
      .rejects.toThrow(`transport=${name} (bank: openai)`);
    expect(transport.requests).toHaveLength(0);
  });
  it('identifies through Codex when an explicitly enrolled Codex bank matches', async () => {
    const bank = syntheticBank();
    bank.protocol.transport = 'codex';
    const result = await fingerprint(new MemoryTransport(['17 '.repeat(128)], 'message', 'codex'), { bank, tokenizerProbe: false });
    expect(result.status).toBe('IDENTIFIED');
    expect(result.model).toBe('synthetic-17');
    expect(result.samples).toHaveLength(128);
    expect(result.earlyStopped).toBe(false);
  });
  it.each([
    ['codex', 'message', false], ['codex', 'message', true],
    ['claude', 'token', false], ['claude', 'token', true],
  ] as const)('compares %s against API references (%s, explicit bank=%s) only as a full-budget heuristic', async (name, granularity, explicit) => {
    const bank = syntheticBank();
    const original = structuredClone(bank);
    vi.spyOn(bankLoader, 'defaultBank').mockReturnValue(bank);
    const transport = new MemoryTransport(Array<string>(128).fill('17 '), granularity, name);
    const result = await fingerprint(transport, {
      ...(explicit ? { bank } : {}), tokenizerProbe: false, allowTransportMismatch: true,
    });
    expect(result).toMatchObject({
      status: 'HEURISTIC_MATCH', model: 'synthetic-17', confidence: null, earlyStopped: false,
      sampleBudgetSaved: 0, evaluatedSamples: 128,
      crossTransport: { probeTransport: name, bankTransport: 'openai' },
    });
    expect(result.samples).toHaveLength(128);
    expect(result.scores.find((score) => score.id === 'synthetic-17')?.weight).toBeGreaterThan(0.995);
    expect(result.reason).toContain('has not been validated');
    expect(result.warnings.join(' ')).toContain('early stopping is disabled');
    expect(bank).toEqual(original);
  });
  it('keeps other protocol checks when opting into another transport', async () => {
    const transport = new MemoryTransport(['17 '.repeat(128)], 'message', 'codex');
    const options = { bank: syntheticBank(), tokenizerProbe: false, allowTransportMismatch: true };
    await expect(fingerprint(transport, { ...options, samples: 64 })).rejects.toThrow('samples=64 (bank: 128)');
    await expect(fingerprint(transport, { ...options, language: 'zh' })).rejects.toThrow('language=zh (bank: en)');
    await expect(fingerprint(transport, { ...options, temperature: 0.5 })).rejects.toThrow('temperature=0.5 (bank: null)');
    options.bank.protocol.temperature = 0.7;
    await expect(fingerprint(transport, options)).rejects.toThrow('CLI drivers do not expose a sampling temperature');
    expect(transport.requests).toHaveLength(0);
  });
  it('does not mistake a short reply at a calibrated checkpoint for a cross-transport match', async () => {
    const result = await fingerprint(new MemoryTransport(['17 '.repeat(64)], 'message', 'codex'), {
      bank: syntheticBank(), tokenizerProbe: false, allowTransportMismatch: true,
    });
    expect(result).toMatchObject({ status: 'INCONCLUSIVE', model: null, confidence: null, scores: [], evaluatedSamples: 0, earlyStopped: false });
    expect(result.reason).toContain('requires all 128 integers; received 64');
  });
  it('retains reference-envelope rejection when all API models differ from Codex output', async () => {
    const result = await fingerprint(new MemoryTransport(['100 '.repeat(128)], 'message', 'codex'), {
      bank: syntheticBank(), tokenizerProbe: false, allowTransportMismatch: true,
    });
    expect(result).toMatchObject({ status: 'UNKNOWN_MODEL', model: null, confidence: null, earlyStopped: false });
    expect(result.crossTransport).toEqual({ probeTransport: 'codex', bankTransport: 'openai' });
    expect(result.scores).toHaveLength(2);
    expect(result.scores.every((score) => !score.accepted && score.weight === null)).toBe(true);
    expect(result.reason).toContain('Experimental comparison across transports');
  });
  it('does not turn an uncalibrated bank into cross-transport reference measurements', async () => {
    const result = await fingerprint(new MemoryTransport(['1 2 3 4'], 'message', 'codex'), {
      bank: uncalibratedBank(), samples: 4, tokenizerProbe: false, allowTransportMismatch: true,
    });
    expect(result.status).toBe('UNCALIBRATED');
    expect(result.crossTransport).toBeUndefined();
    expect(result.scores).toEqual([]);
  });
  it('does not downgrade a matched transport just because the opt-in flag was supplied', async () => {
    const result = await fingerprint(new MemoryTransport(['17 '.repeat(128)]), {
      bank: syntheticBank(), tokenizerProbe: false, allowTransportMismatch: true,
    });
    expect(result.status).toBe('IDENTIFIED');
    expect(result.earlyStopped).toBe(true);
    expect(result.crossTransport).toBeUndefined();
  });
  it('keeps classification and protocol checks for a compatible implicit bank', async () => {
    vi.spyOn(bankLoader, 'defaultBank').mockReturnValue(syntheticBank());
    const transport = new MemoryTransport(['17 '.repeat(128)]);
    const result = await fingerprint(transport, { tokenizerProbe: false });
    expect(result.status).toBe('IDENTIFIED');
    expect(result.earlyStopped).toBe(true);
    const mismatch = new MemoryTransport(['17 '.repeat(128)]);
    await expect(fingerprint(mismatch, { samples: 64, tokenizerProbe: false })).rejects.toThrow('samples=64 (bank: 128)');
    expect(mismatch.requests).toHaveLength(0);
  });
  it('forwards the overall timeout to every transport request', async () => {
    const transport = new MemoryTransport(['1 2 3 4 ']);
    await fingerprint(transport, { bank: uncalibratedBank(), samples: 4, tokenizerProbe: true, timeoutMs: 600_000 });
    expect(transport.requests.map((request) => request.timeoutMs)).toEqual([600_000, 600_000]);
  });
  it('runs the diagnostic tokenizer challenge only on request', async () => {
    const quiet = new MemoryTransport(['1 2 3 4 ']);
    expect((await fingerprint(quiet, { bank: uncalibratedBank(), samples: 4 })).tokenizer).toBeNull();
    expect(quiet.requests).toHaveLength(1);
    const diagnostic = new MemoryTransport(['1 2 3 4 ']);
    const result = await fingerprint(diagnostic, { bank: uncalibratedBank(), samples: 4, tokenizerProbe: true });
    expect(result.tokenizer).toEqual({ response: '1 2 3 4 ', diagnosticOnly: true });
    expect(diagnostic.requests).toHaveLength(2);
  });
  it('reports an oversized tokenizer reply as a provider response error', async () => {
    const transport = new MemoryTransport(['x'.repeat(40_000)]);
    await expect(fingerprint(transport, { bank: uncalibratedBank(), samples: 4, tokenizerProbe: true }))
      .rejects.toMatchObject({ code: 'PROVIDER_RESPONSE', message: 'Tokenizer response exceeded 32 KiB' });
    expect(transport.closed).toBe(true);
  });
  it.each(['openai', 'anthropic'])('calibrates %s HTTP probes with a mixed-format api bank', async (name) => {
    const bank = syntheticBank();
    bank.protocol.transport = 'api';
    const result = await fingerprint(new MemoryTransport(['17 '.repeat(128)], 'token', name), { bank });
    expect(result).toMatchObject({ status: 'IDENTIFIED', model: 'synthetic-17' });
    expect(result.crossTransport).toBeUndefined();
  });
  it.each(['codex', 'claude'])('does not lend an api bank to the %s CLI driver', async (name) => {
    const bank = syntheticBank();
    bank.protocol.transport = 'api';
    const transport = new MemoryTransport(['17 '.repeat(128)], 'message', name);
    await expect(fingerprint(transport, { bank })).rejects.toThrow(`transport=${name} (bank: api)`);
    expect(transport.requests).toHaveLength(0);
  });
  it('honors external cancellation and closes the source on parser failure', async () => {
    const controller = new AbortController();
    controller.abort(new Error('User cancelled'));
    await expect(fingerprint(new MemoryTransport(['17 ']), { bank: uncalibratedBank(), signal: controller.signal })).rejects.toThrow('User cancelled');
    const transport = new MemoryTransport(['hello ']);
    await expect(fingerprint(transport, { bank: uncalibratedBank(), tokenizerProbe: false })).rejects.toThrow('Invalid integer');
    expect(transport.closed).toBe(true);
  });
});

describe('output budget, deadlines, and single-model banks', () => {
  it('forwards a configured output budget and defaults to samples * 5 + 64', async () => {
    const configured = new MemoryTransport(['1 2 3 4 ']);
    await fingerprint(configured, { bank: uncalibratedBank(), samples: 4, maxTokens: 8192 });
    expect(configured.requests[0]!.maxTokens).toBe(8192);
    const fallback = new MemoryTransport(['1 2 3 4 ']);
    await fingerprint(fallback, { bank: uncalibratedBank(), samples: 4 });
    expect(fallback.requests[0]!.maxTokens).toBe(84);
  });
  it.each([3, 4.5, Number.NaN])('rejects maxTokens=%s before any request', async (maxTokens) => {
    const transport = new MemoryTransport(['1 2 3 4 ']);
    await expect(fingerprint(transport, { bank: uncalibratedBank(), samples: 4, maxTokens })).rejects.toThrow(RangeError);
    expect(transport.requests).toHaveLength(0);
  });
  it.each([
    ['before its first chunk', [] as string[]],
    ['after a partial reply', ['17 ']],
  ])('enforces the deadline on a transport that ignores the signal %s', async (_name, chunks) => {
    const hung: ProbeTransport = {
      name: 'openai', granularity: 'token',
      async *stream() {
        for (const chunk of chunks) yield chunk;
        await new Promise(() => {});
      },
    };
    const started = performance.now();
    await expect(fingerprint(hung, { bank: uncalibratedBank(), samples: 4, timeoutMs: 50 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(performance.now() - started).toBeLessThan(2_000);
  });
  it('rejects promptly on external cancellation of a hung transport', async () => {
    const controller = new AbortController();
    const hung: ProbeTransport = { name: 'openai', granularity: 'token', async *stream() { await new Promise(() => {}); } };
    const pending = fingerprint(hung, { bank: uncalibratedBank(), samples: 4, signal: controller.signal });
    setTimeout(() => controller.abort(new Error('User cancelled')), 10);
    await expect(pending).rejects.toThrow('User cancelled');
  });
  it('reports a single-model bank as unable to identify, keeping its OOD verdict', async () => {
    const run = Array<number>(128).fill(17);
    const bank = createFingerprintBank({
      source: 'SYNTHETIC single-model fixture', checkpoints: [64, 128],
      protocol: { id: 'integer-v1', targetSamples: 128, language: 'en', temperature: null, transport: 'openai' },
      models: [{ id: 'only', family: 'synthetic', training: [run, run, run], validation: [run, run] }],
    });
    const result = await fingerprint(new MemoryTransport(['17 '.repeat(128)]), { bank });
    expect(result).toMatchObject({ status: 'INCONCLUSIVE', model: null, confidence: null, evaluatedSamples: 128 });
    expect(result.reason).toContain('at least two calibrated reference models');
    expect(result.scores).toEqual([expect.objectContaining({ id: 'only', accepted: true, weight: null })]);
    expect(result.warnings.join(' ')).toContain('enrolls one calibrated model');
  });
  it('labels protocol mismatches and malformed output with stable error codes', async () => {
    await expect(fingerprint(new MemoryTransport([]), { bank: syntheticBank(), samples: 100 })).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' });
    await expect(fingerprint(new MemoryTransport(['hello ']), { bank: uncalibratedBank() })).rejects.toMatchObject({ code: 'MALFORMED_OUTPUT', name: 'IntegerOutputError' });
  });
});

describe('probe planning', () => {
  it.each([
    // probe, bank transport, explicit bank, opt-in, calibrated, crossTransport, incompatibleDefault
    ['openai', 'api', false, false, true, false, false],
    ['anthropic', 'api', false, false, true, false, false],
    ['anthropic', 'openai', false, false, false, false, true],
    ['claude', 'api', false, false, false, false, true],
    ['codex', 'api', false, true, true, true, false],
    ['codex', 'api', true, true, true, true, false],
    ['codex', 'codex', true, false, true, false, false],
  ] as const)('%s probe with a %s bank (explicit=%s, opt-in=%s)', (name, transport, explicit, optIn, calibrated, crossTransport, incompatibleDefault) => {
    const bank = syntheticBank();
    bank.protocol.transport = transport;
    const plan = planProbe({ name, granularity: 'token' }, bank, explicit, { allowTransportMismatch: optIn });
    expect({ calibrated: plan.calibrated.length > 0, crossTransport: plan.crossTransport, incompatibleDefault: plan.incompatibleDefault })
      .toEqual({ calibrated, crossTransport, incompatibleDefault });
  });
  it('rejects an explicit bank for another transport without an opt-in', () => {
    const bank = syntheticBank();
    bank.protocol.transport = 'api';
    expect(() => planProbe({ name: 'codex', granularity: 'message' }, bank, true)).toThrow('transport=codex (bank: api)');
  });
  it('warns on every Codex probe that a tool can start before the probe stops it', () => {
    // codex-cli keeps some tools despite the driver's overrides; the README alone does not reach CLI users.
    const warnings = (name: string) => planProbe({ name, granularity: 'message' }, uncalibratedBank(), true).warnings.join(' ');
    expect(warnings('codex')).toContain('Codex can start a tool before the probe stops it');
    expect(warnings('claude')).not.toContain('Codex can start a tool');
  });
});
