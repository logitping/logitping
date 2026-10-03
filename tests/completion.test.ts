import { describe, expect, it, vi } from 'vitest';
import { HttpClient, type HttpClientOptions } from '../src/core/client.js';

const request = { prompt: 'test', maxTokens: 100 };
const options = { baseURL: 'https://example.com/v1', model: 'reference', apiKey: 'test-secret' };
const chat = (content: unknown = '17 355', finishReason: unknown = 'stop') => ({
  choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content, reasoning_content: '999' } }],
  usage: { completion_tokens: 12345 },
});
const responses = (content: unknown = [{ type: 'output_text', text: '17 355' }], status = 'completed') => ({
  status, error: null, incomplete_details: null,
  output: [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: '999' }] },
    { type: 'function_call', arguments: '123' },
    { type: 'message', role: 'assistant', status: 'completed', content },
  ],
  output_text: '17 355', usage: { output_tokens: 12345 },
});
const messages = (content: unknown = [{ type: 'thinking', thinking: '999' }, { type: 'text', text: '17 355' }], stopReason: unknown = 'end_turn') => ({
  type: 'message', role: 'assistant', stop_reason: stopReason, content,
});
const formats = {
  chat: { provider: 'openai', tokenLimitField: 'max_completion_tokens' },
  responses: { provider: 'openai', apiFormat: 'responses' },
  messages: { provider: 'anthropic' },
} satisfies Record<string, Partial<HttpClientOptions>>;

describe('non-streaming JSON completions', () => {
  it.each([
    ['chat', chat(), '/chat/completions', 'max_completion_tokens'],
    ['responses', responses(), '/responses', 'max_output_tokens'],
    ['messages', messages(), '/messages', 'max_tokens'],
  ] as const)('requests a full %s response and samples assistant text only', async (format, payload, suffix, tokenField) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(payload));
    const client = new HttpClient({ ...options, ...formats[format], fetch });
    expect(await client.complete({ ...request, temperature: 0.7 })).toBe('17 355');
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(options.baseURL + suffix);
    expect(init?.redirect).toBe('error');
    const headers = new Headers(init?.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get(format === 'messages' ? 'x-api-key' : 'authorization'))
      .toBe(format === 'messages' ? 'test-secret' : 'Bearer test-secret');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      model: 'reference', stream: false, [tokenField]: 100, temperature: 0.7,
      ...(format === 'responses' ? { input: [{ role: 'user', content: 'test' }], store: false }
        : { messages: [{ role: 'user', content: 'test' }] }),
    });
  });

  it('explains a Messages token-limit stop even when the partial answer contains integers', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(messages([
      { type: 'thinking', thinking: 'private-provider-reasoning' },
      { type: 'text', text: '17 '.repeat(512) },
    ], 'max_tokens')));
    const client = new HttpClient({ ...options, ...formats.messages, fetch });
    const error = await client.complete({ ...request, maxTokens: 8192 }).catch((caught: unknown) => caught);
    expect(String(error)).toContain('stop_reason=max_tokens; maxTokens=8192');
    expect(String(error)).toContain('increase maxTokens for this model');
    expect(String(error)).not.toContain('private-provider-reasoning');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['chat', chat('17 '.repeat(512), 'length'), '(finish_reason=length; maxTokens=2624)'],
    ['responses', { ...responses(undefined, 'incomplete'), incomplete_details: { reason: 'max_output_tokens' } }, '(status=incomplete; reason=max_output_tokens; maxTokens=2624)'],
    ['messages', messages(undefined, 'max_tokens'), '(stop_reason=max_tokens; maxTokens=2624)'],
  ] as const)('names the token limit and its value when a %s completion is cut off', async (format, payload, detail) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(payload));
    const client = new HttpClient({ ...options, ...formats[format], fetch });
    const error = await client.complete({ ...request, maxTokens: 2624 }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(`Probe response hit the output token limit ${detail}; reasoning and answer tokens share this limit; increase maxTokens for this model in the bank-update config`);
  });

  it.each([
    ['chat', chat('17 355', 'content_filter'), '(finish_reason=content_filter)'],
    ['chat', chat('17 355', null), '(finish_reason=missing)'],
    ['chat', chat('17 355', 'secret provider text'), '(finish_reason=unrecognized)'],
    ['responses', { ...responses(undefined, 'incomplete'), incomplete_details: { reason: 'content_filter' } }, '(status=incomplete; reason=content_filter)'],
    ['responses', { ...responses(undefined, 'incomplete'), incomplete_details: { reason: 'secret provider text' } }, '(status=incomplete; reason=unrecognized)'],
    ['responses', responses(undefined, 'failed'), '(status=failed)'],
    ['messages', messages(undefined, 'pause_turn'), '(stop_reason=pause_turn)'],
    ['messages', messages(undefined, null), '(stop_reason=missing)'],
  ] as const)('reports why a %s completion did not finish without echoing provider text (%#)', async (format, payload, detail) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(payload));
    const client = new HttpClient({ ...options, ...formats[format], fetch });
    const error = await client.complete(request).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(`Probe response did not finish normally ${detail}`);
  });

  it('decodes fragmented UTF-8 JSON and concatenates text blocks in order', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(responses([
      { type: 'output_text', text: '你好 3' }, { type: 'output_text', text: '55' },
    ])));
    let offset = 0;
    const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(offset, ++offset));
      },
    }), { headers: { 'content-type': 'application/json; charset=utf-8' } });
    const client = new HttpClient({ ...options, ...formats.responses, fetch });
    expect(await client.complete(request)).toBe('你好 355');
  });

  it.each([
    ['chat', chat('17 355', 'length')],
    ['chat', chat('17 355', null)],
    ['chat', chat(null)],
    ['chat', { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '17', refusal: 'secret' } }] }],
    ['responses', responses(undefined, 'incomplete')],
    ['responses', responses(undefined, 'failed')],
    ['responses', { ...responses(), incomplete_details: { reason: 'max_output_tokens' } }],
    ['responses', { ...responses(), output: [{ type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: '17' }] }] }],
    ['responses', responses([{ type: 'refusal', refusal: 'secret' }])],
    ['responses', responses([{ type: 'output_text', text: null }])],
    ['responses', { status: 'completed', output_text: '17 355' }],
    ['responses', { ...responses(), error: { message: 'secret' } }],
    ['messages', messages(undefined, 'max_tokens')],
    ['messages', messages(undefined, null)],
    ['messages', messages([{ type: 'thinking', thinking: '17 355' }])],
    ['messages', { ...messages(), stop_details: { type: 'refusal', explanation: 'secret' } }],
  ] as const)('rejects incomplete, refused, or malformed %s completions (%#)', async (format, payload) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(payload));
    const client = new HttpClient({ ...options, ...formats[format], fetch });
    const error = await client.complete(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('secret');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['{secret-broken-json', 'application/json', 200, 'Malformed JSON'],
    ['data: [DONE]\n\n', 'text/event-stream', 200, 'Expected a non-streaming JSON response'],
    ['secret', 'text/html', 502, 'HTTP 502'],
  ] as const)('rejects invalid bodies and HTTP failures without logging their contents (%#)', async (body, contentType, status, message) => {
    const fetch: typeof globalThis.fetch = async () => new Response(body, { status, headers: { 'content-type': contentType } });
    const client = new HttpClient({ ...options, ...formats.chat, fetch });
    const error = await client.complete(request).catch((caught: unknown) => caught);
    expect(String(error)).toContain(message);
    expect(String(error)).not.toContain('secret');
  });

  it('bounds JSON bodies to 16 MiB and cancels oversized responses', async () => {
    const cancel = vi.fn();
    const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024).fill(32)); }, cancel,
    }), { headers: { 'content-type': 'application/json' } });
    const client = new HttpClient({ ...options, ...formats.chat, fetch });
    await expect(client.complete(request)).rejects.toThrow('exceeded 16 MiB');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(['deadline', 'cancellation'])('cancels a stalled JSON body on %s', async (mode) => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream({
      pull() { if (mode === 'cancellation') controller.abort(new Error('User interrupted collection')); }, cancel,
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } });
    const client = new HttpClient({ ...options, ...formats.chat, fetch });
    await expect(client.complete({ ...request, signal: controller.signal, timeoutMs: 15 }))
      .rejects.toThrow(mode === 'deadline' ? 'timed out' : 'User interrupted collection');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
