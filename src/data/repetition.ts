/** Longest repeat length checked; a cycle must also fit at least four times into the run. */
export const LOOP_MAX_PERIOD = 128;
/** Share of positions that must repeat the integer one period earlier. */
export const LOOP_MIN_SHARE = 0.9;

/**
 * The shortest period at which a run repeats itself, if any. Collection rejects such runs:
 * a model cycling through a few values describes the loop, not its integer preferences.
 * Capping the period at a quarter of the run keeps a coincidental match between a few
 * distant positions, such as equal first and last values, from counting as a loop.
 */
export function findRepeatingCycle(samples: readonly number[]): { period: number; share: number } | undefined {
  const maxPeriod = Math.min(LOOP_MAX_PERIOD, Math.floor(samples.length / 4));
  for (let period = 1; period <= maxPeriod; period++) {
    let repeats = 0;
    for (let index = period; index < samples.length; index++) if (samples[index] === samples[index - period]) repeats++;
    const share = repeats / (samples.length - period);
    if (share >= LOOP_MIN_SHARE) return { period, share };
  }
  return undefined;
}
