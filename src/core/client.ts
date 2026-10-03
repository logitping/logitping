import { createParser } from 'eventsource-parser';
import { asRecord, MAX_PAYLOAD_BYTES } from '../util/validate.js';
import { abortScope } from './abort.js';
import { LogitpingError } from './errors.js';
import { FORMATS, tokenLimitField, wireFormat, type ApiFormat, type FormatAdapter, type TokenLimitField } from './formats.js';
import { httpErrorMessage } from './http_error.js';
import type { ProbeRequest, ProbeTransport, Provider } from './types.js';

export type { ApiFormat, TokenLimitField } from './formats.js';

export interface HttpClientOptions {
  provider: Provider;
  /** OpenAI request/response format; Anthropic uses its native Messages format. */
  apiFormat?: ApiFormat;
  baseURL: string;
  apiKey?: string;
  model: string;
  /** Some recent OpenAI models require max_completion_tokens instead of max_tokens. */
  tokenLimitField?: TokenLimitField;
  /** Additional gateway headers. Standard content/auth headers take precedence. */
  headers?: Readonly<Record<string, string>>;
  /** Require a normal stop in stream(); complete() always requires one. */
  requireCompleteResponse?: boolean;
  allowInsecureHttp?: boolean;
  /** Injectable for integration tests or a controlled custom fetch implementation. */
  fetch?: typeof globalThis.fetch;
}

/** Printable ASCII without spaces: anything else cannot be a credential and would be echoed by header validation. */
const CREDENTIAL = /^[\x21-\x7e]+$/;
/** Header values may contain spaces and obs-text, never NUL or line breaks. */
const HEADER_VALUE = /^[^\0\r\n]*$/;

const providerError = (message: string) => new LogitpingError('PROVIDER_RESPONSE', message);

/** Decode one chunk, or flush the decoder without a chunk; invalid UTF-8 is a provider fault. */
function decodeUtf8(decoder: TextDecoder, chunk?: Uint8Array): string {
  try { return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode(); }
  catch { throw providerError('Probe response is not valid UTF-8'); }
}

/**
 * Node's fetch rejects with TypeError('fetch failed') and keeps the reason in `cause`. Name the
 * host and the cause's code, never its free text.
 */
function networkError(url: URL, error: TypeError): LogitpingError {
  const cause = asRecord(error.cause);
  const detail = cause.message === 'unexpected redirect'
    ? 'the endpoint redirected; redirects are refused so credentials never follow them, so use the final URL'
    : cause.message === 'bad port'
      ? `port ${url.port} is blocked by the Fetch standard; use another port`
      : typeof cause.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(cause.code) ? cause.code : 'network error';
  return new LogitpingError('NETWORK', `Could not reach ${url.host}: ${detail}`, { cause: error });
}

export function completionURL(baseURL: string, provider: Provider, allowInsecureHttp = false, apiFormat: ApiFormat = 'chat-completions'): URL {
  const url = new URL(baseURL);
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError('Endpoint URL must not contain credentials, query parameters, or a fragment');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (local || allowInsecureHttp))) {
    throw new TypeError('Endpoint must use HTTPS (localhost HTTP is allowed)');
  }
  const suffix = FORMATS[wireFormat(provider, apiFormat)].path;
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith(suffix) ? path : `${path.endsWith('/v1') ? path : `${path}/v1`}${suffix}`;
  return url;
}

export class HttpClient implements ProbeTransport {
  readonly name: Provider;
  readonly granularity = 'token' as const;
  // ES private fields, not TypeScript `private`: JSON.stringify() and util.inspect() must never
  // reach the key or gateway headers, for example when a caller logs the transport.
  readonly #options: Omit<HttpClientOptions, 'apiKey'>;
  readonly #url: URL;
  readonly #format: FormatAdapter;
  readonly #tokenField: TokenLimitField;
  readonly #apiKey: string | undefined;

  constructor(options: HttpClientOptions) {
    const { apiKey, ...settings } = options;
    const format = wireFormat(options.provider, options.apiFormat);
    if (typeof options.model !== 'string' || !options.model.trim()) throw new TypeError('An API model identifier is required');
    // Validate before Headers does: its TypeError quotes the rejected value, including a key.
    // Surrounding whitespace (a CRLF .env file) is trimmed, as Headers would; an empty key sends none.
    if (apiKey !== undefined && typeof apiKey !== 'string') throw new TypeError('apiKey must be a string');
    this.#apiKey = apiKey?.trim() || undefined;
    if (this.#apiKey !== undefined && !CREDENTIAL.test(this.#apiKey)) throw new TypeError('apiKey must be printable ASCII without internal whitespace');
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (typeof value !== 'string' || !HEADER_VALUE.test(value)) throw new TypeError(`Header ${name.slice(0, 64)} has an invalid value`);
    }
    this.#options = settings;
    this.#format = FORMATS[format];
    this.#tokenField = tokenLimitField(format, options.tokenLimitField);
    this.name = options.provider;
    this.#url = completionURL(options.baseURL, options.provider, options.allowInsecureHttp, options.apiFormat);
  }

  async #sendRequest(request: ProbeRequest, signal: AbortSignal, stream: boolean): Promise<Response> {
    if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0) throw new RangeError('maxTokens must be a positive integer');
    signal.throwIfAborted();
    const headers = new Headers(this.#options.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Accept', stream ? 'text/event-stream' : 'application/json');
    for (const [name, value] of Object.entries(this.#format.headers(this.#apiKey))) headers.set(name, value);
    const init: RequestInit = {
      method: 'POST', headers, signal,
      body: JSON.stringify(this.#format.body(request, this.#options.model, stream, this.#tokenField)),
      // Never forward credentials to a redirect target, including same-origin path redirects.
      redirect: 'error',
    };
    let response: Response;
    try {
      response = await (this.#options.fetch ?? globalThis.fetch)(this.#url, init);
    } catch (error) {
      // The Fetch standard rejects network failures with TypeError; a custom fetch's own errors pass through.
      if (!signal.aborted && error instanceof TypeError) throw networkError(this.#url, error);
      throw error;
    }
    if (!response.ok) throw new LogitpingError('HTTP_STATUS', await httpErrorMessage(response, signal), { status: response.status });
    return response;
  }

  /** Request one complete JSON response; never request or decode SSE. */
  async complete(request: ProbeRequest): Promise<string> {
    const scope = abortScope(request.signal, request.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => { void reader?.cancel().catch(() => {}); };
    scope.signal.addEventListener('abort', cancel, { once: true });
    try {
      const response = await this.#sendRequest(request, scope.signal, false);
      const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!/^application\/(?:[\w.-]+\+)?json$/.test(mediaType) || !response.body) {
        await response.body?.cancel();
        throw providerError('Expected a non-streaming JSON response');
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0;
      let text = '';
      while (true) {
        scope.signal.throwIfAborted();
        const next = await reader.read();
        scope.signal.throwIfAborted();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_PAYLOAD_BYTES) throw providerError('Probe response exceeded 16 MiB');
        text += decodeUtf8(decoder, next.value);
      }
      text += decodeUtf8(decoder);
      let payload: unknown;
      try { payload = JSON.parse(text); }
      catch { throw providerError('Malformed JSON in probe response'); }
      const result = asRecord(payload);
      if (result.error || result.type === 'error') throw providerError('Provider returned a completion error');
      const answer = this.#format.completeText(result, request.maxTokens);
      if (!answer.trim()) throw providerError('Probe response is missing assistant text');
      return answer;
    } catch (error) {
      if (scope.signal.aborted) throw scope.signal.reason;
      throw error;
    } finally {
      scope.signal.removeEventListener('abort', cancel);
      scope.controller.abort();
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      scope.dispose();
    }
  }

  async *stream(request: ProbeRequest): AsyncGenerator<string> {
    const scope = abortScope(request.signal, request.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    // Do not rely on the fetch implementation to end a pending body read on abort.
    const cancel = () => { void reader?.cancel().catch(() => {}); };
    scope.signal.addEventListener('abort', cancel, { once: true });
    try {
      const response = await this.#sendRequest(request, scope.signal, true);
      if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') || !response.body) {
        await response.body?.cancel();
        throw providerError('Expected a streaming SSE response');
      }
      const state = this.#format.streamState(this.#options.requireCompleteResponse === true);
      const queue: string[] = [];
      const parser = createParser({
        maxBufferSize: 1_048_576,
        onEvent: (message) => { queue.push(...state.onEvent(message)); },
        onError: (error) => {
          // Per the SSE specification, unknown fields and invalid retry values are ignored.
          if (error.type === 'unknown-field' || error.type === 'invalid-retry') return;
          throw providerError('Malformed or oversized SSE event');
        },
      });
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0;
      while (!state.done) {
        scope.signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) {
          parser.feed(decodeUtf8(decoder));
          if (!state.done && !state.finished) throw providerError('SSE connection ended before a completion event');
          break;
        }
        bytes += next.value.byteLength;
        if (bytes > MAX_PAYLOAD_BYTES) throw providerError('Probe stream exceeded 16 MiB');
        parser.feed(decodeUtf8(decoder, next.value));
        for (const text of queue) {
          scope.signal.throwIfAborted();
          yield text;
        }
        queue.length = 0;
      }
      scope.signal.throwIfAborted();
      if (this.#options.requireCompleteResponse && !state.finished) throw providerError('Probe response is missing a normal stop event');
    } catch (error) {
      if (scope.signal.aborted) throw scope.signal.reason;
      throw error;
    } finally {
      scope.signal.removeEventListener('abort', cancel);
      scope.controller.abort();
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      scope.dispose();
    }
  }
}
