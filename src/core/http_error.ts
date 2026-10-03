import { asRecord } from '../util/validate.js';

const MAX_ERROR_BYTES = 16_384;
const knownCodes = new Set([
  'unsupported_parameter', 'invalid_request_error', 'invalid_api_key',
  'model_not_found', 'insufficient_quota', 'rate_limit_exceeded',
  'invalid_parameter', 'missing_required_parameter', 'unsupported_value',
]);
const knownParameters = ['max_tokens', 'max_completion_tokens', 'max_output_tokens', 'temperature', 'model', 'messages', 'input', 'stream', 'reasoning_effort'];
/** Error categories in `error.type` (Anthropic, and OpenAI alongside `code`): fixed identifiers, safe to report. */
const knownTypes = new Set([
  'invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error',
  'request_too_large', 'rate_limit_error', 'api_error', 'overloaded_error', 'server_error',
]);

/** What the status alone suggests checking; a provider outage is not a credential problem. */
function statusHint(status: number): string {
  if (status === 401 || status === 403) return 'check the API key and its permissions';
  if (status === 404) return 'check the endpoint path and model identifier';
  if (status >= 500) return 'provider or gateway failure; retry later';
  return 'check endpoint, model, authentication, and quota';
}

/** Diagnose bounded JSON errors without ever logging provider-supplied prose. */
export async function httpErrorMessage(response: Response, signal: AbortSignal): Promise<string> {
  let generic = `API request failed (HTTP ${response.status}); ${statusHint(response.status)}`;
  if (response.status === 429) {
    generic += '; provider rate or quota limit: check limits and billing before restarting';
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter && /^\d{1,6}$/.test(retryAfter)) generic += `; retry after ${Number(retryAfter)} seconds`;
  }
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('json')) {
    await response.body?.cancel().catch(() => {});
    return generic;
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const timer = setTimeout(cancel, 2_000);
  timer.unref();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    let bytes = 0;
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_ERROR_BYTES) return generic;
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const body = asRecord(JSON.parse(text));
    const errors = [body, asRecord(body.error), ...(Array.isArray(body.errors) ? body.errors.map(asRecord) : [])];
    const details = new Set<string>();
    for (const error of errors) {
      if (typeof error.code === 'number' && Number.isSafeInteger(error.code) && error.code >= 0 && error.code <= 999_999) details.add(`provider code ${error.code}`);
      if (typeof error.code === 'string' && knownCodes.has(error.code)) details.add(`code ${error.code}`);
      if (typeof error.type === 'string' && knownTypes.has(error.type)) details.add(`type ${error.type}`);
      if (typeof error.param === 'string' && knownParameters.includes(error.param)) details.add(`parameter ${error.param}`);
      const message = typeof error.message === 'string' ? error.message : '';
      if (message.includes('max_tokens') && message.includes('max_completion_tokens')) {
        details.add('token limit mismatch: set tokenLimitField to max_completion_tokens for this model');
      } else if (/responses/i.test(message) && /not supported|only|requires|use /i.test(message)) {
        details.add('check apiFormat: this model may require responses with max_output_tokens');
      }
      if (/insufficient.*(?:quota|credit|balance)|(?:quota|credits|balance).*(?:exceeded|exhausted|insufficient)/i.test(message)) {
        details.add('provider quota or credits exhausted; check billing and per-model limits');
      }
    }
    return details.size ? `${generic}; ${[...details].join('; ')}` : generic;
  } catch {
    return generic;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
