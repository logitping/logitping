import { smoothCounts } from './hellinger.js';

export const INTEGER_MIN = 1;
export const INTEGER_MAX = 355;
export const BLOCK_COUNT = 4;
export const FEATURE_DIMENSION = INTEGER_MAX * (BLOCK_COUNT + 1) + 10;
export const FEATURE_VERSION = 'ordered-4-mod10-v1' as const;

export function assertIntegerSample(value: number): void {
  if (!Number.isInteger(value) || value < INTEGER_MIN || value > INTEGER_MAX) {
    throw new RangeError(`Integer samples must be in [${INTEGER_MIN}, ${INTEGER_MAX}]`);
  }
}

export function integerHistogram(samples: readonly number[]): number[] {
  const counts = Array<number>(INTEGER_MAX).fill(0);
  for (const sample of samples) {
    assertIntegerSample(sample);
    counts[sample - 1]!++;
  }
  return counts;
}

export interface OrderedBlockFeatures {
  global: number[];
  blocks: number[][];
  endings: number[];
  /** Probability vector: global 1/3, four blocks 1/12 each, endings 1/3. */
  vector: number[];
}

export function orderedBlockFeatures(samples: readonly number[], alpha = 0.5): OrderedBlockFeatures {
  const global = smoothCounts(integerHistogram(samples), alpha);
  const blocks = Array.from({ length: BLOCK_COUNT }, (_, i) => {
    const start = Math.floor((i * samples.length) / BLOCK_COUNT);
    const end = Math.floor(((i + 1) * samples.length) / BLOCK_COUNT);
    return smoothCounts(integerHistogram(samples.slice(start, end)), alpha);
  });
  const endingCounts = Array<number>(10).fill(0);
  for (const sample of samples) endingCounts[sample % 10]!++;
  const endings = smoothCounts(endingCounts, alpha);
  const vector = [
    ...global.map((x) => x / 3),
    ...blocks.flatMap((block) => block.map((x) => x / 12)),
    ...endings.map((x) => x / 3),
  ];
  return { global, blocks, endings, vector };
}
