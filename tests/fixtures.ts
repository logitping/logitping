import type { FingerprintBank, ProbeRequest, ProbeTransport, StreamGranularity } from '../src/core/types.js';
import { createFingerprintBank, type EnrollmentInput } from '../src/data/enrollment.js';
import { createPooledBank } from '../src/data/pooled_enrollment.js';
import { FAMILY_SIZES } from '../src/math/pooled_features.js';
import { mulberry32 } from '../src/math/pooled_sets.js';

export function uncalibratedBank(): FingerprintBank {
  return {
    schemaVersion: 1, featureVersion: 'ordered-4-mod10-v1', alpha: 0.5,
    protocol: { id: 'integer-v1', targetSamples: 512, language: 'en', temperature: null, transport: 'openai' },
    nuisanceDirections: [], calibration: null,
    models: [{ id: 'uncalibrated-test', family: 'synthetic', status: 'uncalibrated',
      integerProbabilities: Array<number>(355).fill(1 / 355), profiles: [], provenance: 'Synthetic test prior' }],
  };
}

/** Deliberately artificial, trivially separable models. Never a real model bank. */
export function syntheticBank(): FingerprintBank {
  const run = (value: number) => Array<number>(128).fill(value);
  const bank = createFingerprintBank({
    source: 'SYNTHETIC TEST FIXTURE; no real model measurements',
    protocol: { id: 'integer-v1', targetSamples: 128, language: 'en', temperature: null, transport: 'openai' },
    checkpoints: [64, 128],
    models: [17, 287].map((value) => ({
      id: `synthetic-${value}`, family: 'synthetic',
      training: [run(value), run(value), run(value)], validation: [run(value), run(value)],
    })),
  });
  bank.calibration!.sequentialValidated = true;
  return bank;
}

export class MemoryTransport implements ProbeTransport {
  requests: ProbeRequest[] = [];
  closed = false;
  aborted = false;
  constructor(private readonly chunks: string[], readonly granularity: StreamGranularity = 'token', readonly name: string = 'openai') {}

  async *stream(request: ProbeRequest): AsyncGenerator<string> {
    this.requests.push(request);
    try {
      for (const chunk of this.chunks) {
        request.signal?.throwIfAborted();
        yield chunk;
      }
    } finally {
      this.closed = true;
      this.aborted = request.signal?.aborted ?? false;
    }
  }
}

/** A schema-v2 bank with a uniform pooled section, for validation tests that need no real calibration. */
export function uniformPooledBank(requestsPerProbe = 4): FingerprintBank {
  const bank = syntheticBank();
  bank.schemaVersion = 2;
  bank.protocol.requestsPerProbe = requestsPerProbe;
  bank.protocol.scoring = 'pooled-sets-v1';
  bank.pooled = {
    alpha: 0.2, bootstrap: { draws: 2000, seed: 1 },
    models: bank.models.map((model) => ({ id: model.id, families: FAMILY_SIZES.map((size) => Array<number>(size).fill(1 / size)), cutoffs: { fit: 0, margin: 0 } })),
    pairs: bank.models.flatMap((model) => bank.models.filter((other) => other !== model)
      .map((other) => ({ model: model.id, competitor: other.id, weights: Array<number>(FAMILY_SIZES.length).fill(1), center: 0, scale: 1 }))),
  };
  return bank;
}

/** 64 integers drawn uniformly from [low, high] with a fixed seed. */
export function syntheticRun(low: number, high: number, seed: number): number[] {
  const random = mulberry32(seed);
  return Array.from({ length: 64 }, () => low + Math.floor(random() * (high - low + 1)));
}

/** Deliberately artificial runs: three models drawing from mostly separate ranges. Never a real model bank. */
export function syntheticEnrollment(): EnrollmentInput {
  return {
    source: 'SYNTHETIC POOLED TEST FIXTURE; no real model measurements',
    protocol: { id: 'integer-v1', targetSamples: 64, language: 'en', temperature: null, transport: 'openai' },
    checkpoints: [64],
    models: ([[1, 120], [118, 237], [236, 355]] as const).map(([low, high], index) => ({
      id: `synthetic-${low}-${high}`, family: 'synthetic',
      training: Array.from({ length: 6 }, (_, run) => syntheticRun(low, high, index * 100 + run)),
      validation: Array.from({ length: 4 }, (_, run) => syntheticRun(low, high, index * 100 + 50 + run)),
    })),
  };
}

export function syntheticPooledBank(requestsPerProbe = 4): FingerprintBank {
  return createPooledBank({ ...syntheticEnrollment(), requestsPerProbe });
}

/** Answers request i with replies[i]; 'stall' waits until the request is aborted. */
export class SequenceTransport implements ProbeTransport {
  requests: ProbeRequest[] = [];
  abortedAtStart: boolean[] = [];
  onRequest?: (index: number) => void;
  constructor(private readonly replies: (string[] | 'stall')[], readonly granularity: StreamGranularity = 'token', readonly name: string = 'openai') {}

  async *stream(request: ProbeRequest): AsyncGenerator<string> {
    const index = this.requests.push(request) - 1;
    this.abortedAtStart.push(request.signal?.aborted ?? false);
    this.onRequest?.(index);
    const reply = this.replies[index] ?? [];
    if (reply === 'stall') {
      request.signal?.throwIfAborted();
      await new Promise<never>((_, reject) => request.signal?.addEventListener('abort', () => reject(request.signal!.reason), { once: true }));
      return;
    }
    for (const chunk of reply) {
      request.signal?.throwIfAborted();
      yield chunk;
    }
  }
}

/** Accept every response in every envelope, so a test isolates the fit and margin tests. */
export function openEnvelopes(bank: FingerprintBank): FingerprintBank {
  for (const model of bank.models) for (const profile of model.profiles) { profile.maxHellinger = 1; profile.maxMahalanobis = Number.MAX_VALUE; }
  return bank;
}

/** Force each model into (`true`) or out of the prediction set through its cutoffs. */
export function forceCutoffs(bank: FingerprintBank, pass: readonly boolean[]): FingerprintBank {
  bank.pooled!.models.forEach((model, index) => {
    const value = pass[index] ? -1e12 : 1e12;
    model.cutoffs = { fit: value, margin: value };
  });
  return bank;
}
