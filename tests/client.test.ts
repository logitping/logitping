import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { completionURL, HttpClient, type HttpClientOptions } from '../src/core/client.js';

const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const delta = (text: string) => event({ choices: [{ index: 0, delta: { content: text } }] });
const request = { prompt: 'test', maxTokens: 100 };

async function collect(source: AsyncIterable<string>) {
  let text = '';
  for await (const chunk of source) text += chunk;
  return text;
}

function mockFetch(body: string, options: { contentType?: string; status?: number; fragment?: boolean } = {}) {
  const cancel = vi.fn();
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else {
        const next = options.fragment ? offset + 1 : bytes.length;
        controller.enqueue(bytes.slice(offset, next));
        offset = next;
      }
    },
    cancel,
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(stream, {
    status: options.status ?? 200, headers: { 'content-type': options.contentType ?? 'text/event-stream' },
  }));
  return { fetch, cancel };
}

describe('endpoint routing and credential handling', () => {
  it.each([
    ['https://example.com', 'https://example.com/v1/chat/completions'],
    ['https://example.com/v1/', 'https://example.com/v1/chat/completions'],
    ['https://example.com/proxy/v1/chat/completions', 'https://example.com/proxy/v1/chat/completions'],
  ])('normalizes %s', (input, expected) => {
    expect(completionURL(input, 'openai').href).toBe(expected);
  });
  it('accepts complete Anthropic URLs and local HTTP, rejecting unsafe URLs', () => {
    expect(completionURL('https://example.com/v1/messages', 'anthropic').pathname).toBe('/v1/messages');
    expect(completionURL('http://localhost:8080', 'openai').protocol).toBe('http:');
    for (const url of ['http://example.com', 'https://user:pass@example.com', 'file:///tmp/a', 'https://example.com?key=secret']) {
      expect(() => completionURL(url, 'openai')).toThrow();
    }
  });
  it('sends credentials in headers and refuses redirects', async () => {
    const mock = mockFetch(delta('17 ') + 'data: [DONE]\n\n');
    const client = new HttpClient({ provider: 'openai', baseURL: 'https://example.com', apiKey: 'test-secret', model: 'claimed', fetch: mock.fetch });
    expect(await collect(client.stream(request))).toBe('17 ');
    const [url, init] = mock.fetch.mock.calls[0]!;
    expect(String(url)).not.toContain('test-secret');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-secret');
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(init?.body as string)).toMatchObject({ model: 'claimed', stream: true });
  });
  it('rejects malformed keys and header values without echoing them', () => {
    const base = { provider: 'openai', baseURL: 'https://example.com', model: 'claimed' } as const;
    const failure = (options: Partial<HttpClientOptions>) => {
      try { new HttpClient({ ...base, ...options }); } catch (caught) { return (caught as Error).message; }
      return 'no error';
    };
    for (const apiKey of ['sk-secret\ninjected', 'sk-secret injected', 'sk-secr\u00e9t']) {
      expect(failure({ apiKey })).toBe('apiKey must be printable ASCII without internal whitespace');
    }
    expect(failure({ headers: { 'cf-aig-authorization': 'Bearer secret\r\nX-Injected: 1' } })).toBe('Header cf-aig-authorization has an invalid value');
  });
  it.each([
    ['a blank model', { model: ' ' }],
    ['a non-string key', { apiKey: 42 as unknown as string }],
    ['a key with internal whitespace', { apiKey: 'sk-secret injected' }],
    ['a header value with a line break', { headers: { 'x-gateway': 'a\r\nb' } }],
    ['an unknown provider', { provider: 'mistral' as unknown as 'openai' }],
    ['an unknown API format', { apiFormat: 'completions' as unknown as 'responses' }],
    ['a token field the format lacks', { tokenLimitField: 'max_output_tokens' as const }],
    ['credentials in the endpoint URL', { baseURL: 'https://user:pass@example.com' }],
    ['plain HTTP to a remote host', { baseURL: 'http://example.com' }],
    ['a malformed endpoint URL', { baseURL: 'not a url' }],
  ])('reports %s as a TypeError: a caller mistake, not a probe failure', (_label, options) => {
    expect(() => new HttpClient({ provider: 'openai', baseURL: 'https://example.com', model: 'test', ...options })).toThrow(TypeError);
  });
  it('trims a key read from a CRLF file and treats an empty key as none', async () => {
    for (const [apiKey, expected] of [['test-secret\r', 'Bearer test-secret'], ['', null]] as const) {
      const mock = mockFetch(delta('17 ') + 'data: [DONE]\n\n');
      await collect(new HttpClient({ provider: 'openai', baseURL: 'https://example.com', apiKey, model: 'claimed', fetch: mock.fetch }).stream(request));
      expect(new Headers(mock.fetch.mock.calls[0]![1]?.headers).get('authorization')).toBe(expected);
    }
  });
  it('keeps the key and gateway headers out of serialization and inspection', () => {
    const client = new HttpClient({
      provider: 'openai', baseURL: 'https://example.com', model: 'claimed', apiKey: 'sk-test-secret',
      headers: { 'cf-aig-authorization': 'Bearer gateway-secret' },
    });
    for (const view of [JSON.stringify(client), inspect(client, { depth: Infinity, showHidden: true })]) {
      expect(view).not.toContain('sk-test-secret');
      expect(view).not.toContain('gateway-secret');
    }
  });
  it('supports the alternative OpenAI token budget field', async () => {
    const mock = mockFetch('data: [DONE]\n\n');
    await collect(new HttpClient({ provider: 'openai', baseURL: 'https://example.com', model: 'test', tokenLimitField: 'max_completion_tokens', fetch: mock.fetch }).stream(request));
    const body = JSON.parse(mock.fetch.mock.calls[0]![1]?.body as string);
    expect(body.max_completion_tokens).toBe(100);
    expect(body.max_tokens).toBeUndefined();
  });
});

describe('SSE decoding', () => {
  it('decodes fragmented UTF-8 and ignores reasoning, role, and usage numbers', async () => {
    const body = ': heartbeat\n\n' + event({ choices: [{ index: 0, delta: { reasoning_content: '12345', role: 'assistant' } }] }) +
      delta('你好 3') + delta('55 ') + event({ usage: { completion_tokens: 999 } }) + 'data: [DONE]\n\n';
    const mock = mockFetch(body, { fragment: true });
    const client = new HttpClient({ provider: 'openai', baseURL: 'https://example.com', model: 'test', fetch: mock.fetch });
    expect(await collect(client.stream(request))).toBe('你好 355 ');
  });
  it('decodes Anthropic text deltas, excluding thinking and tool JSON', async () => {
    const body = event({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '22' } }) +
      event({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '33' } }) +
      event({ type: 'content_block_delta', delta: { type: 'text_delta', text: '17 355' } }) + event({ type: 'message_stop' });
    const mock = mockFetch(body, { fragment: true });
    const client = new HttpClient({ provider: 'anthropic', baseURL: 'https://example.com', apiKey: 'secret', model: 'test', fetch: mock.fetch });
    expect(await collect(client.stream(request))).toBe('17 355');
    const headers = new Headers(mock.fetch.mock.calls[0]![1]?.headers);
    expect(headers.get('x-api-key')).toBe('secret');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
  });
  it.each([
    ['data: {bad}\n\n', 'Malformed JSON'],
    [delta('17 '), 'ended before'],
    [event({ error: { message: 'secret' } }), 'stream error'],
  ])('rejects invalid and interrupted responses', async (body, message) => {
    const client = new HttpClient({ provider: 'openai', baseURL: 'https://example.com', model: 'test', fetch: mockFetch(body).fetch });
    await expect(collect(client.stream(request))).rejects.toThrow(message);
  });
  it.each([
    ['stream', 'text/event-stream', ['data: ', [0xff], '\n\n']],
    ['stream', 'text/event-stream', [delta('17 '), [0xe4, 0xbd]]],
    ['complete', 'application/json', ['{"text":"', [0xff], '"}']],
  ] as const)('reports invalid UTF-8 from %s() as a provider response error', async (mode, contentType, parts) => {
    const body = new Uint8Array(parts.flatMap((part) => typeof part === 'string' ? [...new TextEncoder().encode(part)] : [...part]));
    const fetch = async () => new Response(body, { headers: { 'content-type': contentType } });
    const client = new HttpClient({ provider: 'openai', baseURL: 'https://example.com', model: 'test', fetch });
    const pending = mode === 'stream' ? collect(client.stream(request)) : client.complete(request);
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE', message: 'Probe response is not valid UTF-8' });
  });
  it('rejects non-SSE and HTTP errors without echoing response secrets', async () => {
    for (const options of [{ status: 401 }, { contentType: 'text/html' }]) {
      const client = new HttpClient({ provider: 'openai', baseURL: 'https://example.com', model: 'test', fetch: mockFetch('secret-token', options).fetch });
      await expect(collect(client.stream(request))).rejects.toThrow();
      await expect(collect(client.stream(request))).rejects.not.toThrow('secret-token');
    }
  });
  it('cancels the reader and request as soon as the consumer stops', async () => {
    let observed: AbortSignal | null | undefined;
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      observed = init?.signal;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(delta('17 '))); },
        cancel,
      }), { headers: { 'content-type': 'text/event-stream' } });
    });
    const client = new HttpClient({ provider: 'openai', baseURL: 'https://example.com', model: 'test', fetch });
    for await (const text of client.stream(request)) { expect(text).toBe('17 '); break; }
    expect(observed?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('ignores unknown SSE fields and invalid retry values, as the specification requires', async () => {
    const body = 'x-trace: abc\nretry: soon\n' + delta('17 ') + 'data: [DONE]\n\n';
    const client = new HttpClient({ provider: 'openai', baseURL: 'https://example.com', model: 'test', fetch: mockFetch(body).fetch });
    expect(await collect(client.stream(request))).toBe('17 ');
  });
  it('still rejects an oversized SSE event', async () => {
    const client = new HttpClient({ provider: 'openai', baseURL: 'https://example.com', model: 'test', fetch: mockFetch(`data: ${'1'.repeat(1_100_000)}`).fetch });
    await expect(collect(client.stream(request))).rejects.toThrow('Malformed or oversized SSE event');
  });
  it('ends a stalled stream on deadline even when the body ignores the abort signal', async () => {
    const cancel = vi.fn();
    const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/event-stream' } });
    const client = new HttpClient({ provider: 'openai', baseURL: 'https://example.com', model: 'test', fetch });
    await expect(collect(client.stream({ ...request, timeoutMs: 15 }))).rejects.toMatchObject({ name: 'TimeoutError', message: 'Probe timed out after 15 ms' });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('aborts a stalled request on deadline', async () => {
    const fetch: typeof globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
    const client = new HttpClient({ provider: 'openai', baseURL: 'https://example.com', model: 'test', fetch });
    await expect(collect(client.stream({ ...request, timeoutMs: 15 }))).rejects.toThrow('timed out');
  });
});

describe('network failures', () => {
  /** Node's fetch shape: TypeError('fetch failed') with the DNS, socket, or TLS failure as its cause. */
  const failingFetch = (cause: Error): typeof globalThis.fetch => async () => { throw new TypeError('fetch failed', { cause }); };
  const systemError = (code: string) => Object.assign(new Error(`connect ${code} example.com secret-detail`), { code });
  const client = (fetch: typeof globalThis.fetch, baseURL = 'https://example.com') =>
    new HttpClient({ provider: 'openai', baseURL, model: 'test', fetch });

  it.each(['ENOTFOUND', 'ECONNREFUSED', 'DEPTH_ZERO_SELF_SIGNED_CERT'])('reports %s as NETWORK, naming only the host and code', async (code) => {
    const error = await collect(client(failingFetch(systemError(code))).stream(request)).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'LogitpingError', code: 'NETWORK', message: `Could not reach example.com: ${code}` });
    expect((error as Error).cause).toMatchObject({ name: 'TypeError', message: 'fetch failed' });
  });
  it('explains a refused redirect instead of an opaque fetch failure', async () => {
    await expect(client(failingFetch(new Error('unexpected redirect'))).complete(request)).rejects.toMatchObject({
      code: 'NETWORK', message: 'Could not reach example.com: the endpoint redirected; redirects are refused so credentials never follow them, so use the final URL',
    });
  });
  it('explains a port that the Fetch standard refuses to use', async () => {
    await expect(client(failingFetch(new Error('bad port')), 'https://example.com:6000').complete(request)).rejects.toMatchObject({
      code: 'NETWORK', message: 'Could not reach example.com:6000: port 6000 is blocked by the Fetch standard; use another port',
    });
  });
  it('never echoes a cause code that is not a plain identifier', async () => {
    const error = await collect(client(failingFetch(systemError('secret value'))).stream(request)).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'NETWORK', message: 'Could not reach example.com: network error' });
  });
  it('passes through failures that a custom fetch raises itself', async () => {
    const failure = new Error('gateway served a cached response');
    await expect(collect(client(async () => { throw failure; }).stream(request))).rejects.toBe(failure);
  });
});

describe('Responses API streaming', () => {
  const completed = event({ type: 'response.completed', response: { status: 'completed' } });
  it('routes requests with max_output_tokens and reads text deltas exactly once', async () => {
    const mock = mockFetch(event({ type: 'response.reasoning_text.delta', delta: '999' }) +
      event({ type: 'response.function_call_arguments.delta', delta: '42' }) +
      event({ type: 'response.output_text.delta', delta: '你好 17 ' }) +
      event({ type: 'response.output_text.done', text: '你好 17 ' }) + completed, { fragment: true });
    const client = new HttpClient({ provider: 'openai', apiFormat: 'responses', baseURL: 'https://example.com/v1', model: 'test', requireCompleteResponse: true, fetch: mock.fetch });
    expect(await collect(client.stream(request))).toBe('你好 17 ');
    const [url, init] = mock.fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://example.com/v1/responses');
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'test', input: [{ role: 'user', content: 'test' }], max_output_tokens: 100, store: false, stream: true });
    expect(completionURL('https://example.com/v1/responses', 'openai', false, 'responses').href).toBe('https://example.com/v1/responses');
  });
  it.each([
    event({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }),
    event({ type: 'response.failed', response: { status: 'failed', error: { message: 'secret-token' } } }),
    event({ type: 'response.refusal.delta', delta: 'secret-token' }),
    event({ type: 'response.completed', response: { status: 'incomplete' } }),
    event({ type: 'response.completed', response: { status: 'completed', error: { message: 'secret-token' } } }),
    event({ type: 'response.output_text.done', text: '17 ' }),
    'data: [DONE]\n\n',
  ])('rejects failed, incomplete, refused, or unterminated enrollment streams (%#)', async (terminal) => {
    const mock = mockFetch(event({ type: 'response.output_text.delta', delta: '17 ' }) + terminal);
    const client = new HttpClient({ provider: 'openai', apiFormat: 'responses', baseURL: 'https://example.com', model: 'test', requireCompleteResponse: true, fetch: mock.fetch });
    const error = await collect(client.stream(request)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('secret-token');
  });
  it('rejects incompatible API formats and token limit fields before sending', () => {
    for (const options of [
      { provider: 'anthropic', apiFormat: 'responses' },
      { provider: 'openai', apiFormat: 'responses', tokenLimitField: 'max_tokens' },
      { provider: 'openai', tokenLimitField: 'max_output_tokens' },
    ] as const) {
      expect(() => new HttpClient({ ...options, baseURL: 'https://example.com', model: 'test' })).toThrow();
    }
  });
});

describe('bounded HTTP error diagnostics', () => {
  it('reports rate limits and numeric Retry-After without exposing response text', async () => {
    const fetch: typeof globalThis.fetch = async () => new Response('private-provider-details', { status: 429, headers: { 'retry-after': '30' } });
    const client = new HttpClient({ provider: 'openai', baseURL: 'https://example.com', model: 'test', fetch });
    const error = await collect(client.stream(request)).catch((caught: unknown) => caught);
    expect(String(error)).toContain('provider rate or quota limit');
    expect(String(error)).toContain('retry after 30 seconds');
    expect(String(error)).not.toContain('private-provider-details');
  });
  it.each([
    { error: { code: 'unsupported_parameter', param: 'max_tokens', message: "Unsupported max_tokens: use max_completion_tokens. secret-token" } },
    { errors: [{ code: 1001, message: "max_tokens is not supported; use max_completion_tokens. secret-token" }] },
  ])('explains the token-field mismatch without echoing error prose', async (payload) => {
    const mock = mockFetch(JSON.stringify(payload), { status: 400, contentType: 'application/json', fragment: true });
    const client = new HttpClient({ provider: 'openai', baseURL: 'https://example.com', model: 'test', fetch: mock.fetch });
    const error = await collect(client.stream(request)).catch((caught: unknown) => caught);
    expect(String(error)).toContain('HTTP 400');
    expect(String(error)).toContain('set tokenLimitField to max_completion_tokens');
    expect(String(error)).not.toContain('secret-token');
  });
  it.each([
    JSON.stringify({ error: { code: 'secret-code', param: 'secret-param', message: 'secret-message' } }),
    '{bad-json-secret',
    JSON.stringify({ error: { message: 'secret'.repeat(3000) } }),
  ])('does not expose unknown, malformed, or oversized errors (%#)', async (body) => {
    const mock = mockFetch(body, { status: 400, contentType: 'application/json' });
    const client = new HttpClient({ provider: 'openai', baseURL: 'https://example.com', model: 'test', fetch: mock.fetch });
    const error = await collect(client.stream(request)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('secret');
  });
  it.each([
    [401, 'authentication_error', 'check the API key and its permissions'],
    [403, 'permission_error', 'check the API key and its permissions'],
    [404, 'not_found_error', 'check the endpoint path and model identifier'],
    [529, 'overloaded_error', 'provider or gateway failure; retry later'],
  ])('classifies an Anthropic HTTP %i %s without echoing its message', async (status, type, hint) => {
    const body = JSON.stringify({ type: 'error', error: { type, message: 'secret-token detail' }, request_id: 'req_secret' });
    const client = new HttpClient({ provider: 'anthropic', baseURL: 'https://example.com', model: 'test', fetch: mockFetch(body, { status, contentType: 'application/json' }).fetch });
    const error = await collect(client.stream(request)).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'HTTP_STATUS', status, message: `API request failed (HTTP ${status}); ${hint}; type ${type}` });
    expect(String(error)).not.toContain('secret');
  });
  it('does not blame credentials for a gateway failure without a JSON body', async () => {
    const client = new HttpClient({ provider: 'openai', baseURL: 'https://example.com', model: 'test', fetch: mockFetch('<html>Bad gateway</html>', { status: 502, contentType: 'text/html' }).fetch });
    const error = await collect(client.stream(request)).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'HTTP_STATUS', status: 502, message: 'API request failed (HTTP 502); provider or gateway failure; retry later' });
  });
  it('never echoes an unrecognized error type', async () => {
    const body = JSON.stringify({ type: 'error', error: { type: 'secret_category', message: 'secret' } });
    const client = new HttpClient({ provider: 'anthropic', baseURL: 'https://example.com', model: 'test', fetch: mockFetch(body, { status: 400, contentType: 'application/json' }).fetch });
    const error = await collect(client.stream(request)).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: 'API request failed (HTTP 400); check endpoint, model, authentication, and quota' });
  });
  it('cancels a stalled error body at the request deadline', async () => {
    const cancel = vi.fn();
    const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream({ cancel }), { status: 400, headers: { 'content-type': 'application/json' } });
    const client = new HttpClient({ provider: 'openai', baseURL: 'https://example.com', model: 'test', fetch });
    await expect(collect(client.stream({ ...request, timeoutMs: 15 }))).rejects.toThrow('timed out');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
