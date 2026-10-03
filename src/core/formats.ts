import type { EventSourceMessage } from 'eventsource-parser';
import { asRecord } from '../util/validate.js';
import { LogitpingError } from './errors.js';
import type { ProbeRequest, Provider } from './types.js';

export type ApiFormat = 'chat-completions' | 'responses';
export type TokenLimitField = 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
export type WireFormat = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

/** Incremental decoding of one SSE response. */
export interface StreamState {
  /** Assistant text carried by this event; throws on provider errors and protocol violations. */
  onEvent(message: EventSourceMessage): string[];
  /** A terminal event arrived; later events are ignored. */
  readonly done: boolean;
  /** The provider reported a stop reason. */
  readonly finished: boolean;
}

/** Everything that differs between API wire formats. Transport concerns stay in HttpClient. */
export interface FormatAdapter {
  readonly provider: Provider;
  readonly path: '/chat/completions' | '/responses' | '/messages';
  /** Supported token budget fields; the first is the default. */
  readonly tokenFields: readonly [TokenLimitField, ...TokenLimitField[]];
  readonly tokenFieldError: string;
  headers(apiKey: string | undefined): Record<string, string>;
  body(request: ProbeRequest, model: string, stream: boolean, tokenField: TokenLimitField): Record<string, unknown>;
  /** Assistant text from a complete JSON response, excluding reasoning, tools, and metadata. */
  completeText(response: Record<string, unknown>, maxTokens: number): string;
  streamState(requireComplete: boolean): StreamState;
}

const incomplete = 'Probe response did not finish normally';
const budgetHint = `${incomplete}; check the output token budget`;
const missingText = 'Probe response is missing assistant text';

const providerError = (message: string) => new LogitpingError('PROVIDER_RESPONSE', message);
const truncatedError = (message: string) => new LogitpingError('TRUNCATED', message);

/** A provider stop code for error messages; arbitrary provider text is never echoed. */
function stopCode(value: unknown): string {
  if (value === undefined || value === null) return 'missing';
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/i.test(value) ? value : 'unrecognized';
}

/** Explain an abnormal stop, naming the token limit when it caused the stop. */
function stopError(detail: string, maxTokens: number, tokenLimit: boolean): LogitpingError {
  return tokenLimit
    ? truncatedError(`Probe response hit the output token limit (${detail}; maxTokens=${maxTokens}); reasoning and answer tokens share this limit; increase maxTokens for this model in the bank-update config`)
    : providerError(`${incomplete} (${detail})`);
}

function contentText(content: unknown, textType: 'text' | 'output_text'): string {
  if (!Array.isArray(content)) throw providerError(missingText);
  return content.map((item: unknown) => {
    const block = asRecord(item);
    if (block.type === 'refusal') throw providerError('Provider refused the probe');
    if (block.type !== textType) return '';
    if (typeof block.text !== 'string') throw providerError('Malformed assistant text in probe response');
    return block.text;
  }).join('');
}

function firstChoice(payload: Record<string, unknown>): Record<string, unknown> {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  return asRecord(choices.find((item: unknown) => asRecord(item).index === 0) ?? choices[0]);
}

const userMessage = (request: ProbeRequest) => [{ role: 'user', content: request.prompt }];
const temperature = (request: ProbeRequest) => request.temperature !== undefined ? { temperature: request.temperature } : {};

abstract class SseState implements StreamState {
  done = false;
  finished = false;
  constructor(protected readonly requireComplete: boolean) {}

  onEvent({ data, event }: EventSourceMessage): string[] {
    if (this.done) return [];
    if (data === '[DONE]') {
      this.onDoneMarker();
      this.done = true;
      return [];
    }
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { throw providerError('Malformed JSON in SSE event'); }
    const payload = asRecord(parsed);
    if (event === 'error' || payload.type === 'error' || payload.error) throw providerError('Provider returned a stream error');
    return this.onPayload(payload);
  }

  protected onDoneMarker(): void {}
  protected abstract onPayload(payload: Record<string, unknown>): string[];
}

class ChatStream extends SseState {
  protected onPayload(payload: Record<string, unknown>): string[] {
    const choice = firstChoice(payload);
    const delta = asRecord(choice.delta);
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      this.finished = true;
      if (this.requireComplete && choice.finish_reason !== 'stop') throw (choice.finish_reason === 'length' ? truncatedError : providerError)(incomplete);
    }
    return typeof delta.content === 'string' ? [delta.content] : [];
  }
}

class ResponsesStream extends SseState {
  protected override onDoneMarker(): void {
    if (!this.finished) throw providerError('Responses stream ended before a completion event');
  }

  protected onPayload(payload: Record<string, unknown>): string[] {
    if (payload.type === 'response.failed') throw providerError('Provider returned a stream error');
    if (payload.type === 'response.refusal.delta') throw providerError('Provider refused the probe');
    if (payload.type === 'response.incomplete') {
      const { reason } = asRecord(asRecord(payload.response).incomplete_details);
      if (this.requireComplete) throw (reason === 'max_output_tokens' ? truncatedError : providerError)(budgetHint);
      this.done = true;
    }
    if (payload.type === 'response.completed') {
      const result = asRecord(payload.response);
      if (result.status !== 'completed' || result.error || result.incomplete_details) throw providerError(incomplete);
      this.finished = true;
      this.done = true;
    }
    return payload.type === 'response.output_text.delta' && typeof payload.delta === 'string' ? [payload.delta] : [];
  }
}

class MessagesStream extends SseState {
  protected onPayload(payload: Record<string, unknown>): string[] {
    const delta = asRecord(payload.delta);
    if (payload.type === 'message_delta' && delta.stop_reason !== undefined && delta.stop_reason !== null) {
      this.finished = true;
      if (this.requireComplete && delta.stop_reason !== 'end_turn') throw (delta.stop_reason === 'max_tokens' ? truncatedError : providerError)(incomplete);
    }
    if (payload.type === 'message_stop') this.done = true;
    return payload.type === 'content_block_delta' && delta.type === 'text_delta' && typeof delta.text === 'string' ? [delta.text] : [];
  }
}

const bearer = (apiKey: string | undefined): Record<string, string> => apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

export const FORMATS: Readonly<Record<WireFormat, FormatAdapter>> = {
  'openai-chat': {
    provider: 'openai',
    path: '/chat/completions',
    tokenFields: ['max_tokens', 'max_completion_tokens'],
    tokenFieldError: 'max_output_tokens requires Responses',
    headers: bearer,
    body: (request, model, stream, tokenField) => ({
      model, messages: userMessage(request), stream, [tokenField]: request.maxTokens, ...temperature(request),
    }),
    completeText(response, maxTokens) {
      const choice = firstChoice(response);
      if (choice.finish_reason !== 'stop') throw stopError(`finish_reason=${stopCode(choice.finish_reason)}`, maxTokens, choice.finish_reason === 'length');
      const message = asRecord(choice.message);
      if (message.refusal) throw providerError('Provider refused the probe');
      if (message.role !== 'assistant' || typeof message.content !== 'string') throw providerError(missingText);
      return message.content;
    },
    streamState: (requireComplete) => new ChatStream(requireComplete),
  },
  'openai-responses': {
    provider: 'openai',
    path: '/responses',
    tokenFields: ['max_output_tokens'],
    tokenFieldError: 'Responses requires max_output_tokens',
    headers: bearer,
    body: (request, model, stream, tokenField) => ({
      model, input: userMessage(request), store: false, stream, [tokenField]: request.maxTokens, ...temperature(request),
    }),
    completeText(response, maxTokens) {
      if (response.status !== 'completed' || response.incomplete_details) {
        const { reason } = asRecord(response.incomplete_details);
        const detail = response.incomplete_details ? `; reason=${stopCode(reason)}` : '';
        throw stopError(`status=${stopCode(response.status)}${detail}`, maxTokens, reason === 'max_output_tokens');
      }
      if (!Array.isArray(response.output)) throw providerError(missingText);
      return response.output.map((item: unknown) => {
        const message = asRecord(item);
        if (message.type !== 'message' || message.role !== 'assistant') return '';
        if (message.status !== 'completed') throw providerError(incomplete);
        return contentText(message.content, 'output_text');
      }).join('');
    },
    streamState: (requireComplete) => new ResponsesStream(requireComplete),
  },
  'anthropic-messages': {
    provider: 'anthropic',
    path: '/messages',
    tokenFields: ['max_tokens'],
    tokenFieldError: 'Anthropic requires Messages with max_tokens',
    headers: (apiKey) => ({ ...(apiKey ? { 'x-api-key': apiKey } : {}), 'anthropic-version': '2023-06-01' }),
    body: (request, model, stream, tokenField) => ({
      model, messages: userMessage(request), stream, [tokenField]: request.maxTokens, ...temperature(request),
    }),
    completeText(response, maxTokens) {
      if (response.stop_reason !== 'end_turn') throw stopError(`stop_reason=${stopCode(response.stop_reason)}`, maxTokens, response.stop_reason === 'max_tokens');
      if (asRecord(response.stop_details).type === 'refusal') throw providerError('Provider refused the probe');
      if (response.role !== 'assistant') throw providerError(missingText);
      return contentText(response.content, 'text');
    },
    streamState: (requireComplete) => new MessagesStream(requireComplete),
  },
};

const PROVIDERS: readonly string[] = ['openai', 'anthropic'];
const API_FORMATS: readonly string[] = ['chat-completions', 'responses'];
const TOKEN_FIELDS: readonly string[] = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'];

/** Validate a provider/API format pair from typed or untyped callers. */
export function wireFormat(provider: Provider, apiFormat?: ApiFormat): WireFormat {
  if (!PROVIDERS.includes(provider)) throw new TypeError('Unsupported API provider');
  if (apiFormat && !API_FORMATS.includes(apiFormat)) throw new TypeError('Invalid API format');
  if (provider === 'anthropic') {
    if (apiFormat === 'responses') throw new TypeError(FORMATS['anthropic-messages'].tokenFieldError);
    return 'anthropic-messages';
  }
  return apiFormat === 'responses' ? 'openai-responses' : 'openai-chat';
}

export function tokenLimitField(format: WireFormat, requested?: TokenLimitField): TokenLimitField {
  const adapter = FORMATS[format];
  if (!requested) return adapter.tokenFields[0];
  if (!TOKEN_FIELDS.includes(requested)) throw new TypeError('Invalid token limit field');
  if (!adapter.tokenFields.includes(requested)) throw new TypeError(adapter.tokenFieldError);
  return requested;
}
