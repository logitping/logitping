export function assertVector(values: readonly number[], name = 'vector'): void {
  if (!values.length || values.some((x) => !Number.isFinite(x))) {
    throw new RangeError(`${name} must be a nonempty finite vector`);
  }
}

export function assertDistribution(values: readonly number[]): void {
  assertVector(values, 'distribution');
  const total = values.reduce((sum, x) => sum + x, 0);
  if (values.some((x) => x < 0) || Math.abs(total - 1) > 1e-8) {
    throw new RangeError('Distribution must be nonnegative and sum to one');
  }
}

/** Jeffreys smoothing; the default alpha is 0.5 per category. */
export function smoothCounts(counts: readonly number[], alpha = 0.5): number[] {
  assertVector(counts, 'counts');
  if (!Number.isFinite(alpha) || alpha < 0 || counts.some((x) => x < 0)) {
    throw new RangeError('Counts and alpha must be nonnegative');
  }
  const total = counts.reduce((sum, x) => sum + x, 0) + alpha * counts.length;
  if (!Number.isFinite(total) || total <= 0) throw new RangeError('Invalid count total');
  return counts.map((x) => (x + alpha) / total);
}

/** H(P,Q) = ||sqrt(P) - sqrt(Q)||_2 / sqrt(2), bounded in [0,1]. */
export function hellinger(p: readonly number[], q: readonly number[]): number {
  assertDistribution(p);
  assertDistribution(q);
  if (p.length !== q.length) throw new RangeError('Distribution dimensions must match');
  let squared = 0;
  for (let i = 0; i < p.length; i++) squared += (Math.sqrt(p[i]!) - Math.sqrt(q[i]!)) ** 2;
  return Math.min(1, Math.sqrt(squared / 2));
}
