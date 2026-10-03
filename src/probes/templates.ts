import type { Language } from '../core/types.js';
import { MAX_SAMPLES, MIN_SAMPLES } from '../util/validate.js';

export const PROTOCOL_ID = 'integer-v1' as const;

export function integerPrompt(samples: number, language: Language = 'en'): string {
  if (!Number.isInteger(samples) || samples < MIN_SAMPLES || samples > MAX_SAMPLES) {
    throw new RangeError(`Sample count must be an integer between ${MIN_SAMPLES} and ${MAX_SAMPLES}`);
  }
  if (language === 'zh') {
    return `請依照直覺依序產生 ${samples} 個介於 1 到 355（含）之間的整數。可以重複，不要排序。只輸出以空格分隔的整數，不要編號、解釋、程式碼或標點。不要使用工具。`;
  }
  return `Generate a sequence of ${samples} integers in the closed interval [1, 355], choosing each intuitively. Repetition is allowed; do not sort. Output only integers separated by spaces, with no numbering, explanation, code, or punctuation. Do not use tools.`;
}
