import type { FingerprintBank, ProbeRequest, ProbeTransport, StreamGranularity } from '../src/core/types.js';
import { createFingerprintBank } from '../src/data/enrollment.js';

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
