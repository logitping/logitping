import type { Language } from '../core/types.js';

export const BOUNDARY_CASES = [
  'antidisestablishmentarianism',
  ' leading  spaces\tand\nnewlines',
  '你好，世界！ café cafe\u0301 👩🏽‍💻',
  'HTTPResponse_code=355; snake_case',
] as const;

/** A reproducible behavioral challenge, not direct access to the backend tokenizer. */
export function tokenizerPrompt(language: Language = 'en'): string {
  const instruction = language === 'zh'
    ? '對以下每個字串，估計你的分詞器會如何切分，並回傳由字串陣列組成的 JSON 陣列。每組片段串接後必須等於原字串。只輸出 JSON，不要使用工具。'
    : 'For each string below, estimate how your tokenizer would split it. Return a JSON array of arrays of text pieces; each inner array must concatenate to the exact original string. Output only JSON. Do not use tools.';
  return `${instruction}\n${JSON.stringify(BOUNDARY_CASES)}`;
}
