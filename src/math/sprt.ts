import { assertDistribution } from './hellinger.js';

export interface Hypothesis {
  id: string;
  probabilities: readonly number[];
}

export interface SequentialDecision {
  winner: string | null;
  accepted: boolean;
  samples: number;
  logLikelihoodRatio: number;
  threshold: number;
  /** Equal-prior, enrolled-model-relative weights, not measured identity accuracy. */
  weights: Record<string, number>;
}

/** Observations before the default test accepts any decision; calibrated banks need at least this many. */
export const MIN_SEQUENTIAL_SAMPLES = 64;

/** Multi-hypothesis SPRT under fixed categorical IID hypotheses, with log-domain updates. */
export class SequentialTest {
  private readonly scores: number[];
  private readonly logs: number[][];
  private samples = 0;
  readonly threshold: number;

  constructor(
    private readonly hypotheses: readonly Hypothesis[],
    readonly errorRate = 0.005,
    readonly minSamples = MIN_SEQUENTIAL_SAMPLES,
  ) {
    if (hypotheses.length < 2) throw new RangeError('SPRT requires at least two hypotheses');
    if (!(errorRate > 0 && errorRate < 0.5) || !Number.isInteger(minSamples) || minSamples < 1) {
      throw new RangeError('Invalid SPRT configuration');
    }
    if (new Set(hypotheses.map((h) => h.id)).size !== hypotheses.length || hypotheses.some((h) => !h.id)) {
      throw new RangeError('Hypothesis ids must be nonempty and unique');
    }
    this.logs = hypotheses.map((h) => {
      assertDistribution(h.probabilities);
      if (h.probabilities.length !== hypotheses[0]!.probabilities.length || h.probabilities.some((p) => p <= 0)) {
        throw new RangeError('SPRT distributions must have equal dimensions and strictly positive probabilities');
      }
      return h.probabilities.map(Math.log);
    });
    this.scores = hypotheses.map(() => 0);
    // Union-bound threshold: each wrong hypothesis crossing has probability <= 1/A.
    this.threshold = Math.log((hypotheses.length - 1) / errorRate);
  }

  /** category is zero-based; integer probe values are passed as value - 1. */
  update(category: number): SequentialDecision {
    if (!Number.isInteger(category) || category < 0 || category >= this.logs[0]!.length) {
      throw new RangeError('SPRT category out of range');
    }
    for (let i = 0; i < this.scores.length; i++) this.scores[i]! += this.logs[i]![category]!;
    this.samples++;
    return this.snapshot();
  }

  snapshot(): SequentialDecision {
    const ranked = this.scores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score);
    const best = ranked[0]!;
    const gap = best.score - ranked[1]!.score;
    const exp = this.scores.map((score) => Math.exp(score - best.score));
    const sum = exp.reduce((a, b) => a + b, 0);
    return {
      winner: this.samples ? this.hypotheses[best.index]!.id : null,
      accepted: this.samples >= this.minSamples && gap >= this.threshold,
      samples: this.samples,
      logLikelihoodRatio: gap,
      threshold: this.threshold,
      weights: Object.fromEntries(this.hypotheses.map((h, i) => [h.id, exp[i]! / sum])),
    };
  }
}
