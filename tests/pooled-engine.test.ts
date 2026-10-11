import { describe, expect, it } from 'vitest';
import { fingerprint, planProbe } from '../src/core/engine.js';
import { integerPrompt } from '../src/probes/templates.js';
import { tokenizerPrompt } from '../src/probes/tokenizer.js';
import { forceCutoffs, openEnvelopes, SequenceTransport, syntheticPooledBank, syntheticRun } from './fixtures.js';

const LOW = 'synthetic-1-120';
const MID = 'synthetic-118-237';
const HIGH = 'synthetic-236-355';
/** The low-range model's own training runs, as complete replies. */
const lowReplies = (count = 4) => Array.from({ length: count }, (_, run) => [`${syntheticRun(1, 120, run).join(' ')} `]);

describe('pooled probes', () => {
  it('names the only model that fits every response as a heuristic match', async () => {
    const transport = new SequenceTransport(lowReplies());
    const result = await fingerprint(transport, { bank: openEnvelopes(syntheticPooledBank()) });
    expect(result).toMatchObject({
      status: 'HEURISTIC_MATCH', model: LOW, candidates: [LOW], confidence: null, requests: 4,
      requestedSamples: 256, evaluatedSamples: 256, earlyStopped: false,
    });
    expect(result.samples).toEqual(Array.from({ length: 4 }, (_, run) => syntheticRun(1, 120, run)).flat());
    expect(result.reason).toContain('an unenrolled model from the same vendor');
    expect(transport.requests.map((request) => request.prompt)).toEqual(Array(4).fill(integerPrompt(64, 'en')));
    const low = result.scores.find((score) => score.id === LOW)!;
    expect(low.fit).toBeGreaterThanOrEqual(low.fitCutoff!);
    expect(low.margin).toBeGreaterThanOrEqual(low.marginCutoff!);
    expect(result.warnings.join(' ')).toContain('4 requests of 64 integers');
  });

  it.each([
    [[true, true, false], 'INCONCLUSIVE', null, [LOW, MID], 'Consistent with synthetic-1-120 or synthetic-118-237'],
    [[false, false, false], 'UNKNOWN_MODEL', null, [], 'No enrolled model fits all 4 responses'],
    [[false, false, true], 'HEURISTIC_MATCH', HIGH, [HIGH], 'Only synthetic-236-355 fits all 4 responses'],
  ] as const)('maps the prediction set %j to its status', async (pass, status, model, candidates, reason) => {
    const result = await fingerprint(new SequenceTransport(lowReplies()), { bank: forceCutoffs(openEnvelopes(syntheticPooledBank()), pass) });
    expect(result).toMatchObject({ status, model, candidates: [...candidates], confidence: null });
    expect(result.reason).toContain(reason);
  });

  it('drops a model whose envelope rejects any response', async () => {
    const bank = forceCutoffs(openEnvelopes(syntheticPooledBank()), [true, true, true]);
    bank.models[2]!.profiles[0]!.maxHellinger = 1e-9;
    const result = await fingerprint(new SequenceTransport(lowReplies()), { bank });
    expect(result.candidates).toEqual([LOW, MID]);
    expect(result.scores.find((score) => score.id === HIGH)).toMatchObject({ accepted: false, weight: null });
  });

  it('stops at a short reply and names the request', async () => {
    const replies = lowReplies();
    replies[2] = [`${syntheticRun(1, 120, 2).slice(0, 63).join(' ')} `];
    const transport = new SequenceTransport(replies);
    const result = await fingerprint(transport, { bank: syntheticPooledBank() });
    expect(result).toMatchObject({ status: 'INCONCLUSIVE', model: null, requests: 3, evaluatedSamples: 0, scores: [] });
    expect(result.candidates).toBeUndefined();
    expect(result.reason).toContain('Request 3 of 4 ended after 63 of 64 integers');
    expect(result.reason).toContain('384-token output limit');
    expect(result.samples).toHaveLength(191);
    expect(transport.requests).toHaveLength(3);
  });

  it('stops each request at 64 integers without cancelling the next one', async () => {
    const transport = new SequenceTransport(lowReplies().map(([text]) => [text!, '17 18 19 20 ']));
    const result = await fingerprint(transport, { bank: openEnvelopes(syntheticPooledBank()) });
    expect(transport.abortedAtStart).toEqual([false, false, false, false]);
    expect(result.samples).toHaveLength(256);
    expect(result.status).toBe('HEURISTIC_MATCH');
  });

  it('applies the overall deadline across requests', async () => {
    const transport = new SequenceTransport([...lowReplies(2), 'stall', ...lowReplies(1)]);
    await expect(fingerprint(transport, { bank: syntheticPooledBank(), timeoutMs: 200 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(transport.requests).toHaveLength(3);
  });

  it('sends no further requests after cancellation', async () => {
    const controller = new AbortController();
    const transport = new SequenceTransport([...lowReplies(2), 'stall', ...lowReplies(1)]);
    transport.onRequest = (index) => { if (index === 2) controller.abort(new Error('Interrupted')); };
    await expect(fingerprint(transport, { bank: syntheticPooledBank(), signal: controller.signal })).rejects.toThrow('Interrupted');
    expect(transport.requests).toHaveLength(3);
  });

  it('requires the bank sample count before any request', async () => {
    const transport = new SequenceTransport(lowReplies());
    await expect(fingerprint(transport, { bank: syntheticPooledBank(), samples: 512 })).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' });
    expect(transport.requests).toHaveLength(0);
  });

  it('runs the optional tokenizer probe before the pooled requests', async () => {
    const transport = new SequenceTransport([['a | b'], ...lowReplies()]);
    const result = await fingerprint(transport, { bank: openEnvelopes(syntheticPooledBank()), tokenizerProbe: true });
    expect(transport.requests.map((request) => request.prompt)).toEqual([tokenizerPrompt('en'), ...Array(4).fill(integerPrompt(64, 'en'))]);
    expect(result).toMatchObject({ status: 'HEURISTIC_MATCH', requests: 4, tokenizer: { response: 'a | b', diagnosticOnly: true } });
  });

  it('plans the bank request count and never stops early', () => {
    const bank = syntheticPooledBank();
    bank.calibration!.sequentialValidated = true;
    expect(planProbe({ name: 'openai', granularity: 'token' }, bank, true)).toMatchObject({ requests: 4, count: 64, canStop: false });
  });

  it('labels a cross-transport pooled result as experimental', async () => {
    const transport = new SequenceTransport(lowReplies(), 'message', 'codex');
    const result = await fingerprint(transport, { bank: openEnvelopes(syntheticPooledBank()), allowTransportMismatch: true });
    expect(result).toMatchObject({ status: 'HEURISTIC_MATCH', model: LOW, crossTransport: { probeTransport: 'codex', bankTransport: 'openai' } });
    expect(result.reason).toMatch(/^Experimental comparison across transports\./);
  });

  it('reports progress across requests', async () => {
    const counts: number[] = [];
    await fingerprint(new SequenceTransport(lowReplies()), { bank: syntheticPooledBank(), onProgress: (count) => counts.push(count) });
    expect(counts[64]).toBe(65);
    expect(counts.at(-1)).toBe(256);
  });
});
