/** Standardized head-to-head score of a model against one competitor; positive favors the model. */
export interface PairStatistic {
  weights: number[];
  center: number;
  scale: number;
}

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
/** Pooled within-class variance, as in the prototype. */
const pooledVariance = (a: readonly number[], b: readonly number[], ma: number, mb: number) =>
  (a.reduce((sum, x) => sum + (x - ma) ** 2, 0) + b.reduce((sum, x) => sum + (x - mb) ** 2, 0)) / (a.length + b.length - 2);

/**
 * Diagonal-LDA weights over per-group log-likelihood ratios, clipped at zero, then standardized on
 * the same runs. Rows hold LL(run | model) − LL(run | competitor) for each group.
 */
export function fitPairStatistic(ownRuns: readonly (readonly number[])[], competitorRuns: readonly (readonly number[])[]): PairStatistic {
  const weights = ownRuns[0]!.map((_, group) => {
    const a = ownRuns.map((row) => row[group]!);
    const b = competitorRuns.map((row) => row[group]!);
    const ma = mean(a);
    const mb = mean(b);
    const variance = pooledVariance(a, b, ma, mb);
    return variance > 0 && ma > mb ? (ma - mb) / variance : 0;
  });
  if (!weights.some((weight) => weight !== 0)) weights.fill(1);
  const combine = (row: readonly number[]) => row.reduce((sum, x, group) => sum + weights[group]! * x, 0);
  const da = ownRuns.map(combine);
  const db = competitorRuns.map(combine);
  const ma = mean(da);
  const mb = mean(db);
  return { weights, center: (ma + mb) / 2, scale: Math.sqrt(Math.max(pooledVariance(da, db, ma, mb), 1e-12)) };
}

export function pairScore(statistic: PairStatistic, ratios: readonly number[]): number {
  return (ratios.reduce((sum, x, group) => sum + statistic.weights[group]! * x, 0) - statistic.center) / statistic.scale;
}

/** Combine k responses: the summed fit, and the worst competitor's summed margin divided by sqrt(k). */
export function aggregateScores(fits: readonly number[], margins: readonly (readonly number[])[]): { fit: number; margin: number } {
  const fit = fits.reduce((sum, value) => sum + value, 0);
  let margin = Infinity;
  for (let competitor = 0; competitor < margins[0]!.length; competitor++) {
    const total = margins.reduce((sum, row) => sum + row[competitor]!, 0) / Math.sqrt(fits.length);
    if (total < margin) margin = total;
  }
  return { fit, margin };
}

/**
 * Index into ascending null scores such that `score >= sorted[index]` holds exactly when the
 * conformal p-value (1 + #{null <= score}) / (draws + 1) exceeds alpha / 2.
 */
export function cutoffIndex(alpha: number, draws: number): number {
  return Math.floor((alpha / 2) * (draws + 1)) - 1;
}

/** Small deterministic generator for the enrollment bootstrap, as in the prototype. */
export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
