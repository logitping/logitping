/** Shared limits and structural checks for untrusted JSON and protocol inputs. */

/** Largest JSON body, bank, enrollment input, or CLI event stream accepted in memory. */
export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const MIN_SAMPLES = 4;
export const MAX_SAMPLES = 16_384;
export const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A plain-object view of untrusted JSON; anything else reads as empty. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
