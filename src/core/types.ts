import type { DistanceProfile } from '../math/ood.js';
import type { FEATURE_VERSION } from '../math/ordered_block.js';
import type { POOLED_SCORING } from '../math/pooled_features.js';
import type { PairStatistic } from '../math/pooled_sets.js';

export type Provider = 'openai' | 'anthropic';
export type Language = 'en' | 'zh';
export type StreamGranularity = 'token' | 'message';

export interface ProbeRequest {
  prompt: string;
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProbeTransport {
  readonly name: string;
  readonly granularity: StreamGranularity;
  stream(request: ProbeRequest): AsyncIterable<string>;
}

export interface FingerprintProfile extends DistanceProfile {
  sampleCount: number;
}

/** How a model's reference runs were requested; the same settings are also recorded in its provenance. */
export interface CollectionSettings {
  /** The service the bank updater requested the runs from. */
  provider: 'openai' | 'openrouter' | 'google' | 'cloudflare';
  /** The requested model identifier, such as `anthropic/claude-sonnet-5.5`. */
  route: string;
  apiFormat: 'chat-completions' | 'responses' | 'messages';
  tokenLimitField: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  /** Output-token budget of each request, reasoning included. */
  maxTokens: number;
  collectedAt: string;
  corpusSha256: string;
}

export interface ModelFingerprint {
  id: string;
  family: string;
  status: 'uncalibrated' | 'calibrated';
  integerProbabilities: number[];
  profiles: FingerprintProfile[];
  provenance: string;
  /** Present for models the bank updater collected; older and hand-made banks may lack it. */
  collection?: CollectionSettings;
}

/** Prediction-set calibration of a pooled bank (schema version 2); see docs/methodology.md. */
export interface PooledScoring {
  alpha: number;
  bootstrap: { draws: number; seed: number };
  /** In the order of `FingerprintBank.models`, which `id` repeats. */
  models: { id: string; families: number[][]; cutoffs: { fit: number; margin: number } }[];
  pairs: ({ model: string; competitor: string } & PairStatistic)[];
}

export interface FingerprintBank {
  schemaVersion: 1 | 2;
  featureVersion: typeof FEATURE_VERSION;
  protocol: {
    id: 'integer-v1';
    language: Language;
    targetSamples: number;
    temperature: number | null;
    /**
     * Banks are specific to the transport and its environment. `api` marks references
     * collected through mixed HTTP API formats; it calibrates both HTTP providers.
     */
    transport: 'api' | 'openai' | 'anthropic' | 'claude' | 'codex' | 'antigravity';
    /** Pooled banks (schema version 2): requests per probe, each of `targetSamples` integers. */
    requestsPerProbe?: number;
    scoring?: typeof POOLED_SCORING;
  };
  alpha: 0.5;
  nuisanceDirections: number[][];
  models: ModelFingerprint[];
  calibration: {
    source: string;
    heldOutRuns: number;
    /** Enables nominal IID-based early stopping, only after external sequential validation. */
    sequentialValidated: boolean;
  } | null;
  /** Present exactly when `schemaVersion` is 2. */
  pooled?: PooledScoring;
}

export interface ModelScore {
  id: string;
  hellinger: number;
  mahalanobis: number;
  accepted: boolean;
  /** Relative likelihood among enrolled models; absent when the OOD gate fails. */
  weight: number | null;
  /** Pooled banks only: summed fit and worst head-to-head margin over all responses, with this model's cutoffs. */
  fit?: number;
  margin?: number;
  fitCutoff?: number;
  marginCutoff?: number;
}

export interface ProbeResult {
  status: 'IDENTIFIED' | 'HEURISTIC_MATCH' | 'UNKNOWN_MODEL' | 'INCONCLUSIVE' | 'UNCALIBRATED';
  /** For HEURISTIC_MATCH this names a reference candidate, not a validated identity. */
  model: string | null;
  confidence: number | null;
  confidenceMeaning: 'nominal closed-set IID likelihood; not calibrated identity probability';
  reason: string;
  scores: ModelScore[];
  samples: number[];
  evaluatedSamples: number;
  requestedSamples: number;
  earlyStopped: boolean;
  sampleBudgetSaved: number;
  elapsedMs: number;
  streamGranularity: StreamGranularity;
  tokenizer: { response: string; diagnosticOnly: true } | null;
  warnings: string[];
  /** Present for opt-in reference comparisons whose transport calibration does not transfer. */
  crossTransport?: { probeTransport: string; bankTransport: FingerprintBank['protocol']['transport'] };
  /**
   * Pooled banks, once every request completed: the prediction set, in bank order; one candidate is a
   * HEURISTIC_MATCH and none UNKNOWN_MODEL. Single-request banks, whenever the engine scored the
   * response: enrolled models the sequential test cannot reject against the most likely one and whose
   * envelope accepts, most likely first, and `[]` for UNKNOWN_MODEL. There the length does not
   * determine the status: INCONCLUSIVE can list none, one or several. Absent when nothing was scored.
   */
  candidates?: string[];
  /** Pooled banks only: requests sent for this probe. */
  requests?: number;
}

export interface EngineOptions {
  /** Explicit banks are protocol-checked; an incompatible bundled bank defaults to sample collection. */
  bank?: FingerprintBank;
  /** Compare across transports experimentally; other protocol checks still apply and early stopping is disabled. */
  allowTransportMismatch?: boolean;
  samples?: number;
  /**
   * Output-token budget for the integer request; default `samples * 5 + 64`. Reasoning models
   * spend part of it before answering, so they may need more to return every integer.
   */
  maxTokens?: number;
  language?: Language;
  temperature?: number;
  timeoutMs?: number;
  /** Run the diagnostic tokenizer challenge first. Off by default: it costs a request and is excluded from identification. */
  tokenizerProbe?: boolean;
  earlyStopping?: boolean;
  signal?: AbortSignal;
  /** Model text as it arrives; `request` numbers the integer requests of a pooled probe from 1. */
  onText?: (text: string, stage: 'tokenizer' | 'integers', request?: number) => void;
  onProgress?: (samples: number) => void;
}
