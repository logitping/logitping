export const DEFAULT_TIMEOUT_MS = 120_000;

export function abortScope(parent?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('Timeout must be positive and at most 2147483647 ms');
  }
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  // Same error name as AbortSignal.timeout(), so callers can tell timeouts from cancellation.
  const timer = setTimeout(() => controller.abort(new DOMException(`Probe timed out after ${timeoutMs} ms`, 'TimeoutError')), timeoutMs);
  timer.unref();
  return {
    controller,
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}
