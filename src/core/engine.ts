import { defaultBank, validateBank } from '../data/bank_loader.js';
import { createNuisanceProjector, type Projector } from '../math/nuisance.js';
import { assessOOD } from '../math/ood.js';
import { orderedBlockFeatures } from '../math/ordered_block.js';
import { SequentialTest } from '../math/sprt.js';
import { IntegerStreamParser } from '../probes/integer_stream.js';
import { integerPrompt } from '../probes/templates.js';
import { tokenizerPrompt } from '../probes/tokenizer.js';
import { abortScope, DEFAULT_TIMEOUT_MS } from './abort.js';
import { LogitpingError } from './errors.js';
import type { EngineOptions, FingerprintBank, Language, ModelFingerprint, ModelScore, ProbeRequest, ProbeResult, ProbeTransport } from './types.js';

type Classification = Pick<ProbeResult, 'status' | 'model' | 'confidence' | 'reason' | 'scores' | 'evaluatedSamples'>;
type RequestOptions = Pick<ProbeRequest, 'timeoutMs' | 'temperature'> & { signal: AbortSignal };

/** Whether a probe transport may use a bank's calibration without an explicit opt-in. */
export function transportCompatible(probe: string, bank: FingerprintBank['protocol']['transport']): boolean {
  return probe === bank || (bank === 'api' && (probe === 'openai' || probe === 'anthropic'));
}

export interface ProbePlan {
  /** References used for classification; empty when collecting without identification. */
  calibrated: ModelFingerprint[];
  crossTransport: boolean;
  /** An implicit default bank that cannot calibrate this transport. */
  incompatibleDefault: boolean;
  count: number;
  /** Output-token budget for the integer request. */
  maxTokens: number;
  language: Language;
  prompt: string;
  temperature: number | undefined;
  canStop: boolean;
  checkpoints: ReadonlySet<number>;
  warnings: string[];
}

/** Calibration and protocol policy without I/O. Throws on protocol mismatches before any request. */
export function planProbe(
  transport: Pick<ProbeTransport, 'name' | 'granularity'>,
  bank: FingerprintBank,
  explicitBank: boolean,
  options: EngineOptions = {},
): ProbePlan {
  const enrolled = bank.models.filter((model) => model.status === 'calibrated');
  const transportMismatch = !transportCompatible(transport.name, bank.protocol.transport);
  const crossTransport = enrolled.length > 0 && transportMismatch && options.allowTransportMismatch === true;
  // An automatically selected API bank must not prevent collection through local
  // CLI drivers, or lend its calibration to a different transport. Explicit banks
  // remain strict unless the caller explicitly requests an exploratory comparison.
  const incompatibleDefault = !explicitBank && enrolled.length > 0 && transportMismatch && !crossTransport;
  const calibrated = incompatibleDefault ? [] : enrolled;
  const count = options.samples ?? bank.protocol.targetSamples;
  const maxTokens = options.maxTokens ?? count * 5 + 64;
  const language = options.language ?? bank.protocol.language;
  const temperature = options.temperature ?? (incompatibleDefault ? undefined : bank.protocol.temperature ?? undefined);
  const prompt = integerPrompt(count, language);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < count) {
    throw new RangeError('maxTokens must be an integer of at least the sample count');
  }
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new RangeError('Temperature must be between 0 and 2');
  }
  const mismatches = [
    language !== bank.protocol.language ? `language=${language} (bank: ${bank.protocol.language})` : null,
    count !== bank.protocol.targetSamples ? `samples=${count} (bank: ${bank.protocol.targetSamples})` : null,
    (temperature ?? null) !== bank.protocol.temperature ? `temperature=${temperature ?? null} (bank: ${bank.protocol.temperature})` : null,
    transportMismatch && !crossTransport ? `transport=${transport.name} (bank: ${bank.protocol.transport})` : null,
  ].filter((value) => value !== null);
  if (calibrated.length && mismatches.length) {
    throw new LogitpingError('PROTOCOL_MISMATCH', `Probe protocol differs from the calibrated bank: ${mismatches.join('; ')}. Use a bank collected through ${transport.name} with matching probe settings.`);
  }
  if ((transport.name === 'claude' || transport.name === 'codex') && temperature !== undefined) {
    throw new LogitpingError('PROTOCOL_MISMATCH', 'CLI drivers do not expose a sampling temperature; use a bank with temperature: null');
  }
  const warnings = [
    'Behavioral similarity is not cryptographic provenance; adaptive proxies can imitate these probes.',
    'Nominal confidence assumes fixed IID categorical distributions. LLM integers are dependent; validate error rates empirically.',
  ];
  if (incompatibleDefault) warnings.push(`The bundled bank uses ${bank.protocol.transport}. Supply a bank enrolled through ${transport.name} with --bank <path> to enable model identification.`);
  else if (!calibrated.length) warnings.push('This bank has no measured fingerprints; collected samples cannot identify a model.');
  else if (calibrated.length === 1) warnings.push('This bank enrolls one calibrated model: its OOD gate is reported in scores, but identification needs at least two references.');
  if (crossTransport) warnings.push(`Experimental comparison: ${transport.name} samples against ${bank.protocol.transport} references. Reference weights and distance envelopes have not been validated for this transport; early stopping is disabled.`);
  if (transport.granularity === 'message') warnings.push('This driver delivers completed messages; within-message token or latency savings cannot be inferred.');
  // The driver aborts on the first tool item, but some Codex tools cannot be switched off and race that abort.
  if (transport.name === 'codex') warnings.push('Codex can start a tool before the probe stops it; probe Codex only through backends you would trust with read access to this machine.');
  if (!calibrated.length || !bank.calibration?.sequentialValidated) warnings.push('Early stopping is disabled until sequential behavior has been validated for this bank.');
  return {
    calibrated, crossTransport, incompatibleDefault, count, maxTokens, language, prompt, temperature, warnings,
    canStop: !crossTransport && calibrated.length >= 2 && options.earlyStopping !== false &&
      bank.calibration?.sequentialValidated === true && transport.granularity === 'token',
    checkpoints: new Set(calibrated[0]?.profiles.map((profile) => profile.sampleCount) ?? []),
  };
}

function classify(samples: readonly number[], models: ModelFingerprint[], project: Projector, test?: SequentialTest): Classification {
  const unavailable = (status: 'UNCALIBRATED' | 'INCONCLUSIVE', reason: string): Classification => ({
    status, model: null, confidence: null, reason, scores: [], evaluatedSamples: 0,
  });
  if (!models.length) return unavailable('UNCALIBRATED', 'No measured fingerprints are enrolled in this bank');
  if (!models.every((model) => model.profiles.some((profile) => profile.sampleCount === samples.length))) {
    return unavailable('INCONCLUSIVE', 'No calibrated OOD profile exists for this sample count');
  }
  const features = orderedBlockFeatures(samples).vector;
  const scores: ModelScore[] = models.map((model) => ({
    id: model.id,
    ...assessOOD(features, model.profiles.find((profile) => profile.sampleCount === samples.length)!, project),
    weight: null,
  }));
  if (!scores.some((score) => score.accepted)) {
    return { status: 'UNKNOWN_MODEL', model: null, confidence: null, reason: 'Outside every enrolled model’s calibrated OOD region', scores, evaluatedSamples: samples.length };
  }
  if (!test) {
    return { status: 'INCONCLUSIVE', model: null, confidence: null, reason: 'Identification needs at least two calibrated reference models; see scores for the OOD verdict', scores, evaluatedSamples: samples.length };
  }
  const decision = test.snapshot();
  for (const score of scores) score.weight = decision.weights[score.id] ?? null;
  const winner = scores.find((score) => score.id === decision.winner);
  if (!decision.accepted || !winner?.accepted) {
    return { status: 'INCONCLUSIVE', model: null, confidence: null, reason: 'Insufficient separation between enrolled models, or likelihood and OOD checks disagree', scores, evaluatedSamples: samples.length };
  }
  return { status: 'IDENTIFIED', model: winner.id, confidence: winner.weight, reason: 'Nominal sequential threshold and calibrated OOD gate passed', scores, evaluatedSamples: samples.length };
}

/** Enforce `signal` even on a transport that ignores it: each pending read races the abort. */
async function* abortable<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); });
  aborted.catch(() => {});
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  let reading = false;
  try {
    while (true) {
      signal.throwIfAborted();
      reading = true;
      const next = await Promise.race([iterator.next(), aborted]);
      reading = false;
      if (next.done) return;
      yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    // A source stuck in next() may never settle: ask it to close without waiting for it.
    if (reading) void (async () => iterator.return?.())().catch(() => {});
    else await iterator.return?.();
  }
}

async function runTokenizerProbe(transport: ProbeTransport, plan: ProbePlan, request: RequestOptions, options: EngineOptions): Promise<string> {
  let response = '';
  for await (const text of abortable(transport.stream({ ...request, prompt: tokenizerPrompt(plan.language), maxTokens: 768 }), request.signal)) {
    request.signal?.throwIfAborted();
    response += text;
    if (response.length > 32_768) throw new LogitpingError('PROVIDER_RESPONSE', 'Tokenizer response exceeded 32 KiB');
    options.onText?.(text, 'tokenizer');
  }
  return response;
}

interface Collection {
  samples: number[];
  /** Set when a calibrated checkpoint identified the model before the full budget. */
  early?: Classification;
  test?: SequentialTest;
  project: Projector;
}

async function collectIntegers(
  transport: ProbeTransport,
  bank: FingerprintBank,
  plan: ProbePlan,
  scope: ReturnType<typeof abortScope>,
  request: RequestOptions,
  options: EngineOptions,
): Promise<Collection> {
  const project = createNuisanceProjector(bank.nuisanceDirections);
  const test = plan.calibrated.length >= 2
    ? new SequentialTest(plan.calibrated.map((model) => ({ id: model.id, probabilities: model.integerProbabilities })))
    : undefined;
  const collection: Collection = { samples: [], project, ...(test ? { test } : {}) };
  const { samples } = collection;
  const parser = new IntegerStreamParser();
  const accept = (value: number): boolean => {
    samples.push(value);
    const decision = test?.update(value - 1);
    options.onProgress?.(samples.length);
    if (plan.canStop && decision?.accepted && samples.length < plan.count && plan.checkpoints.has(samples.length)) {
      const result = classify(samples, plan.calibrated, project, test);
      if (result.status === 'IDENTIFIED') {
        collection.early = result;
        // Abort while suspended at yield, so the socket/child is stopped immediately.
        scope.controller.abort();
        return true;
      }
    }
    if (samples.length >= plan.count) { scope.controller.abort(); return true; }
    return false;
  };
  const source = transport.stream({ ...request, prompt: plan.prompt, maxTokens: plan.maxTokens });
  stream: for await (const text of abortable(source, scope.signal)) {
    scope.signal.throwIfAborted();
    options.onText?.(text, 'integers');
    for (const sample of parser.push(text)) if (accept(sample)) break stream;
  }
  if (!scope.signal.aborted) {
    for (const sample of parser.finish()) if (accept(sample)) break;
  }
  return collection;
}

/** Relabel a classification for opt-in cross-transport comparisons and collection-only runs. */
function relabel(result: Classification, plan: ProbePlan, transport: ProbeTransport, bank: FingerprintBank): Classification {
  if (plan.crossTransport) {
    if (result.status !== 'IDENTIFIED') return { ...result, reason: `Experimental comparison across transports. ${result.reason}` };
    return {
      ...result, status: 'HEURISTIC_MATCH', confidence: null,
      reason: `Experimental match to ${result.model} in the ${bank.protocol.transport} reference bank; identity accuracy for ${transport.name} has not been validated.`,
    };
  }
  if (plan.incompatibleDefault) {
    return { ...result, reason: `No calibrated bank for ${transport.name}; the bundled bank uses ${bank.protocol.transport}. Samples collected without model identification.` };
  }
  return result;
}

export async function fingerprint(transport: ProbeTransport, options: EngineOptions = {}): Promise<ProbeResult> {
  const started = performance.now();
  const bank = options.bank ? validateBank(options.bank) : defaultBank();
  const plan = planProbe(transport, bank, Boolean(options.bank), options);
  const warnings = [...plan.warnings];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const scope = abortScope(options.signal, timeoutMs);
  // The engine scope enforces the overall deadline; transports must not impose a shorter default.
  const request: RequestOptions = {
    signal: scope.signal, timeoutMs,
    ...(plan.temperature !== undefined ? { temperature: plan.temperature } : {}),
  };
  try {
    scope.signal.throwIfAborted();
    let tokenizer: ProbeResult['tokenizer'] = null;
    if (options.tokenizerProbe === true) {
      tokenizer = { response: await runTokenizerProbe(transport, plan, request, options), diagnosticOnly: true };
      warnings.push('Tokenizer segmentation is model-reported diagnostic text, not a verified observation of BPE internals.');
    }
    const { samples, early, test, project } = await collectIntegers(transport, bank, plan, scope, request, options);
    options.signal?.throwIfAborted();
    // Distinguish intentional budget/early-stop cancellation from timeout cancellation.
    if (scope.signal.aborted && !early && samples.length < plan.count) scope.signal.throwIfAborted();
    // Only the engine's own validated early stop may classify a prefix. Otherwise an endpoint
    // could end its reply at whichever calibrated checkpoint happens to look most favorable.
    const truncated = !early && samples.length < plan.count && plan.calibrated.length > 0;
    const classification: Classification = truncated
      ? { status: 'INCONCLUSIVE', model: null, confidence: null, scores: [], evaluatedSamples: 0,
          reason: plan.crossTransport
            ? `Cross-transport comparison requires all ${plan.count} integers; received ${samples.length}.`
            : `Identification requires all ${plan.count} requested integers; the response ended after ${samples.length}. A provider stop or the ${plan.maxTokens}-token output limit ends a response early; reasoning models may need a larger maxTokens.` }
      : early ?? classify(samples, plan.calibrated, project, test);
    if (samples.length < plan.count && !early) warnings.push(`The response ended after ${samples.length} of ${plan.count} requested integers (output limit: ${plan.maxTokens} tokens).`);
    return {
      ...relabel(classification, plan, transport, bank),
      confidenceMeaning: 'nominal closed-set IID likelihood; not calibrated identity probability',
      samples, requestedSamples: plan.count, earlyStopped: early !== undefined,
      sampleBudgetSaved: early ? 1 - samples.length / plan.count : 0,
      elapsedMs: Math.round(performance.now() - started), streamGranularity: transport.granularity,
      tokenizer, warnings,
      ...(plan.crossTransport ? { crossTransport: { probeTransport: transport.name, bankTransport: bank.protocol.transport } } : {}),
    };
  } finally { scope.dispose(); }
}
