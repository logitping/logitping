import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, resolveApiKey } from '../src/cli.js';
import type { ProbeRequest } from '../src/core/types.js';
import * as bankLoader from '../src/data/bank_loader.js';
import { forceCutoffs, openEnvelopes, syntheticBank, syntheticEnrollment, syntheticPooledBank, syntheticRun } from './fixtures.js';

const fake = vi.hoisted(() => ({
  requests: [] as ProbeRequest[],
  /** When set, the fake CLI calls this as it starts, then waits to be cancelled instead of answering. */
  onStart: undefined as (() => void) | undefined,
}));
vi.mock('../src/drivers/codex_driver.js', () => ({
  CodexDriver: class {
    readonly name = 'codex';
    readonly granularity = 'message';
    async *stream(request: ProbeRequest) {
      fake.requests.push(request);
      if (fake.onStart) {
        fake.onStart();
        await new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
        });
      }
      yield '17 '.repeat(128);
    }
  },
}));

const prompts = vi.hoisted(() => ({ answers: [] as unknown[] }));
vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  const next = async () => prompts.answers.shift();
  return { ...actual, intro: () => {}, select: next, text: next, password: next };
});

/** Report stdin and stdout as a terminal, as an interactive session does; returns the undo. */
function stubTerminal(): () => void {
  const undo = [process.stdin, process.stdout].map((stream) => {
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY');
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
    return () => {
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
      else delete (stream as { isTTY?: boolean }).isTTY;
    };
  });
  return () => { for (const restore of undo) restore(); };
}

/** A chat-completions stream carrying one reply. */
const sse = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
/** Answer successive requests with the low-range synthetic model's training runs. */
function lowRangeEndpoint() {
  let call = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sse(`${syntheticRun(1, 120, call++).join(' ')} `));
}

/** Deliver a signal as EventEmitter#emit would, but only to the listeners added since `before`. */
function deliver(signal: NodeJS.Signals, before: readonly Function[]): void {
  for (const listener of process.rawListeners(signal).filter((added) => !before.includes(added))) listener.call(process, signal);
}

describe('CLI bank selection', () => {
  let directory: string;
  let stdout: string;
  let stderr: string;
  let previousExitCode: typeof process.exitCode;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'logitping-cli-bank-'));
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    fake.requests.length = 0;
    fake.onStart = undefined;
    prompts.answers.length = 0;
    stdout = '';
    stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => { stdout += String(text); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((text) => { stderr += String(text); return true; });
    vi.spyOn(bankLoader, 'defaultBank').mockImplementation(syntheticBank);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    process.exitCode = previousExitCode;
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('stays subscribed to %s until an interrupted probe has cleaned up', async (signal) => {
    const before = process.rawListeners(signal);
    let reraised = false;
    // signal-exit, which execa's subprocess cleanup and ora load, re-raises a signal when no other
    // listener remains. A real re-raise kills the CLI before it removes its temporary directory
    // and prints the JSON error.
    const signalExit = () => { if (process.listenerCount(signal) === before.length + 1) reraised = true; };
    fake.onStart = () => { process.on(signal, signalExit); };
    try {
      const running = main(['node', 'lping', '--driver', 'codex', '--json']);
      await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
      deliver(signal, before);
      await running;
    } finally {
      process.removeListener(signal, signalExit);
    }
    expect(reraised).toBe(false);
    expect(JSON.parse(stdout)).toEqual({ status: 'ERROR', error: 'Interrupted' });
    expect(process.exitCode).toBe(130);
    expect(process.rawListeners(signal)).toEqual(before);
  });

  it('exits at a second signal instead of waiting for cleanup', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const before = process.rawListeners('SIGTERM');
    fake.onStart = () => {};
    const running = main(['node', 'lping', '--driver', 'codex', '--json']);
    await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
    deliver('SIGTERM', before);
    expect(exit).not.toHaveBeenCalled();
    deliver('SIGTERM', before);
    expect(exit).toHaveBeenCalledWith(130);
    await running;
  });

  it('runs --driver codex without a bank and returns collection-only JSON', async () => {
    await main(['node', 'lping', '--driver', 'codex', '--no-tokenizer', '--json']);
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ status: 'UNCALIBRATED', model: null, confidence: null, scores: [], earlyStopped: false });
    expect(result.samples).toHaveLength(128);
    expect(result.reason).toContain('bundled bank uses openai');
    expect(fake.requests).toHaveLength(1);
    expect(process.exitCode).toBe(2);
    expect(stderr).not.toContain('Error:');
  });

  it('reports the specific transport mismatch for an explicit API bank without invoking Codex', async () => {
    const path = join(directory, 'api-bank.json');
    await writeFile(path, JSON.stringify(syntheticBank()));
    await main(['node', 'lping', '--driver', 'codex', '--bank', path, '--no-tokenizer', '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ERROR', error: expect.stringContaining('transport=codex (bank: openai)') });
    expect(fake.requests).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  it('uses a matching explicit Codex bank for identification', async () => {
    const bank = syntheticBank();
    bank.protocol.transport = 'codex';
    const path = join(directory, 'codex-bank.json');
    await writeFile(path, JSON.stringify(bank));
    await main(['node', 'lping', '--driver', 'codex', '--bank', path, '--no-tokenizer', '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'IDENTIFIED', model: 'synthetic-17' });
    expect(fake.requests).toHaveLength(1);
    expect(process.exitCode).toBe(0);
  });

  it.each([false, true])('allows an experimental API reference comparison with explicit bank=%s', async (explicit) => {
    const path = join(directory, 'api-bank.json');
    await writeFile(path, JSON.stringify(syntheticBank()));
    await main(['node', 'lping', '--driver', 'codex', '--allow-transport-mismatch',
      ...(explicit ? ['--bank', path] : []), '--no-tokenizer', '--json']);
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      status: 'HEURISTIC_MATCH', model: 'synthetic-17', confidence: null, earlyStopped: false,
      crossTransport: { probeTransport: 'codex', bankTransport: 'openai' },
    });
    expect(result.samples).toHaveLength(128);
    expect(result.scores).toHaveLength(2);
    expect(fake.requests).toHaveLength(1);
    expect(process.exitCode).toBe(2);
  });

  it('labels a human-readable match as heuristic without an identity confidence percentage', async () => {
    await main(['node', 'lping', '--driver', 'codex', '--allow-transport-mismatch', '--no-tokenizer']);
    expect(stdout).toContain('Heuristic match: synthetic-17');
    expect(stdout).not.toContain('Nominal model-relative confidence:');
    expect(stdout).toContain('early stopping is disabled');
    expect(process.exitCode).toBe(2);
  });

  it('rejects an out-of-range sample budget before loading a bank or starting a probe', async () => {
    await main(['node', 'lping', '--driver', 'codex', '--samples', '3', '--bank', join(directory, 'missing.json'), '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ERROR', error: '--samples must be between 4 and 16384' });
    expect(fake.requests).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  it('checks the enrollment input size before reading it', async () => {
    const input = join(directory, 'enrollment');
    await mkdir(input);
    await main(['node', 'lping', 'bank-create', '--input', input, '--output', join(directory, 'bank.json')]);
    expect(stderr).toContain('Enrollment input must be a JSON file no larger than 16 MiB');
    expect(process.exitCode).toBe(1);
  });

  it('does not send a vendor environment key to a third-party endpoint', async () => {
    vi.stubEnv('LOGITPING_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'sk-vendor-secret');
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '17 '.repeat(128) } }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'IDENTIFIED' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]![0])).toBe('https://proxy.example/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).has('authorization')).toBe(false);
    expect(stderr).toContain('OPENAI_API_KEY is only sent to https://api.openai.com');
  });

  it('selects Responses with its default budget field and forwards --max-tokens', async () => {
    vi.stubEnv('LOGITPING_API_KEY', 'tool-key');
    const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      event({ type: 'response.output_text.delta', delta: '17 '.repeat(128) }) + event({ type: 'response.completed', response: { status: 'completed' } }),
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--api-format', 'responses', '--max-tokens', '8192', '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'IDENTIFIED' });
    expect(String(fetch.mock.calls[0]![0])).toBe('https://proxy.example/v1/responses');
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ max_output_tokens: 8192 });
  });

  it('includes the error code and HTTP status in JSON errors', async () => {
    vi.stubEnv('LOGITPING_API_KEY', 'tool-key');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 429 }));
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ERROR', code: 'HTTP_STATUS', httpStatus: 429, error: expect.stringContaining('HTTP 429') });
    expect(process.exitCode).toBe(1);
  });

  it('reports an unreachable endpoint as code NETWORK in JSON errors', async () => {
    vi.stubEnv('LOGITPING_API_KEY', 'tool-key');
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND proxy.example'), { code: 'ENOTFOUND' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed', { cause }));
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--json']);
    expect(JSON.parse(stdout)).toEqual({ status: 'ERROR', code: 'NETWORK', error: 'Could not reach proxy.example: ENOTFOUND' });
    expect(process.exitCode).toBe(1);
  });

  it('reports a deadline as code TIMEOUT in JSON errors', async () => {
    vi.stubEnv('LOGITPING_API_KEY', 'tool-key');
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--timeout', '50', '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ERROR', code: 'TIMEOUT', error: 'Probe timed out after 50 ms' });
  });

  it.each([
    // The parser fails before it reaches --json.
    [['--driver', 'codex', '--samples', 'abc', '--json'], "option '--samples <count>' argument 'abc' is invalid. Expected a positive integer"],
    [['--json', '--driver', 'codex', '--bogus'], "unknown option '--bogus'"],
    [['--json', '--driver', 'codex', '--endpoint'], "option '--endpoint <url>' argument missing"],
    [['--json', 'bank-create', '--input', 'enrollment.json'], "required option '--output <path>' not specified"],
  ])('reports the parser error in %j as JSON on stdout and nothing on stderr', async (args, error) => {
    await main(['node', 'lping', ...args]);
    expect(JSON.parse(stdout)).toEqual({ status: 'ERROR', error });
    expect(stderr).toBe('');
    expect(process.exitCode).toBe(1);
    expect(fake.requests).toHaveLength(0);
  });

  it('prints a parser error on stderr and returns instead of exiting the process', async () => {
    await main(['node', 'lping', '--driver', 'codex', '--samples', 'abc']);
    expect(stderr).toBe("error: option '--samples <count>' argument 'abc' is invalid. Expected a positive integer\n");
    expect(stdout).toBe('');
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ['--version', /^\d+\.\d+\.\d+\n$/],
    ['--help', /^Usage: logitping /],
  ])('prints %s and returns without an error exit', async (flag, output) => {
    await main(['node', 'lping', flag]);
    expect(stdout).toMatch(output);
    expect(stderr).toBe('');
    expect(process.exitCode).toBeUndefined();
  });

  it('omits the code for argument errors', async () => {
    await main(['node', 'lping', '--driver', 'codex', '--samples', '3', '--json']);
    expect(JSON.parse(stdout)).toEqual({ status: 'ERROR', error: '--samples must be between 4 and 16384' });
  });

  it('reads the API key from --key-file instead of the command line', async () => {
    vi.stubEnv('LOGITPING_API_KEY', 'environment-key');
    const keyFile = join(directory, 'key.txt');
    await writeFile(keyFile, 'file-key\r\n');
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '17 '.repeat(128) } }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--key-file', keyFile, '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'IDENTIFIED' });
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer file-key');
  });

  it.skipIf(process.platform === 'win32')('reads the API key from a pipe, as with --key-file <(pass show api-key)', async () => {
    const fifo = join(directory, 'key.fifo');
    execFileSync('mkfifo', [fifo]);
    // A separate writer feeds the pipe, as process substitution does.
    const writer = spawn('sh', ['-c', 'printf "pipe-key\\n" > "$1"', 'sh', fifo], { stdio: 'ignore' });
    try {
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '17 '.repeat(128) } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      ));
      await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--key-file', fifo, '--json']);
      expect(JSON.parse(stdout)).toMatchObject({ status: 'IDENTIFIED' });
      expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer pipe-key');
    } finally {
      writer.kill();
    }
  });

  const unusableKeyFiles: [label: string, path: () => Promise<string>, error: string][] = [
    ['larger than 4 KiB', async () => { const path = join(directory, 'large-key.txt'); await writeFile(path, 'k'.repeat(4097)); return path; }, 'Key file must be no larger than 4 KiB'],
    ['a directory', async () => directory, 'Key file must be a regular file or a pipe'],
  ];
  if (process.platform !== 'win32') unusableKeyFiles.push(['an endless device', async () => '/dev/zero', 'Key file must be no larger than 4 KiB']);
  it.each(unusableKeyFiles)('rejects a key file that is %s before any request', async (_label, path, error) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--key-file', await path(), '--json']);
    expect(JSON.parse(stdout)).toEqual({ status: 'ERROR', error });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an empty key file before any request', async () => {
    const keyFile = join(directory, 'empty-key.txt');
    await writeFile(keyFile, '\n');
    const fetch = vi.spyOn(globalThis, 'fetch');
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--key-file', keyFile, '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ERROR', error: 'Key file is empty' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [['--driver', 'codex', '--key-file', 'key.txt'], 'API-only options'],
    [['--endpoint', 'https://proxy.example', '--model', 'm', '--key', 'flag-key', '--key-file', 'key.txt'], 'Use either --key or --key-file'],
    [['--driver', 'codex', '--max-tokens', '8192'], 'API-only options'],
    [['--driver', 'codex', '--api-format', 'responses'], 'API-only options'],
    [['--endpoint', 'https://proxy.example', '--model', 'm', '--api-format', 'completions'], 'API format must be chat-completions or responses'],
    [['--endpoint', 'https://proxy.example', '--model', 'm', '--token-limit-field', 'max_output_tokens'], 'max_output_tokens requires Responses'],
  ])('rejects %j before any request', async (args, message) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await main(['node', 'lping', ...args, '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ERROR', error: expect.stringContaining(message) });
    expect(fetch).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(0);
  });

  it('strips bidirectional controls from streamed model text', async () => {
    vi.stubEnv('LOGITPING_API_KEY', 'tool-key');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '17\u202e71 ' } }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--stream', '--json']);
    expect(stderr).toContain('1771 ');
    expect(stderr).not.toContain('\u202e');
  });

  it('streams the tokenizer reply and the integers on separate lines', async () => {
    vi.stubEnv('LOGITPING_API_KEY', 'tool-key');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => sse(String(init?.body).includes('tokenizer') ? 'segments' : '17 '.repeat(128)));
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--tokenizer', '--stream', '--json']);
    expect(stderr).toContain(`segments\n${'17 '.repeat(128)}\n`);
  });

  it('escapes terminal controls and bidirectional overrides in JSON output without losing them', async () => {
    const response = 'a‮b⁦c\u009b31md\u007fe';
    vi.stubEnv('LOGITPING_API_KEY', 'tool-key');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const content = String(init?.body).includes('tokenizer') ? response : '17 '.repeat(128);
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--tokenizer', '--json']);
    expect(stdout).not.toMatch(/[\u007f\u009b‮⁦]/);
    expect(JSON.parse(stdout).tokenizer.response).toBe(response);
  });

  it('uses the bundled bank when the interactive bank path is left blank', async () => {
    // Like @clack/prompts, the mock resolves an empty text answer as undefined.
    prompts.answers.push('codex', undefined);
    const restore = stubTerminal();
    try { await main(['node', 'lping']); } finally { restore(); }
    expect(stderr).not.toContain('Error:');
    expect(fake.requests).toHaveLength(1);
    expect(stdout).toContain('UNCALIBRATED');
    expect(process.exitCode).toBe(2);
  });

  it('loads a bank path typed at the interactive prompt, ignoring surrounding spaces', async () => {
    const bank = syntheticBank();
    bank.protocol.transport = 'codex';
    const path = join(directory, 'codex-bank.json');
    await writeFile(path, JSON.stringify(bank));
    prompts.answers.push('codex', `  ${path}  `);
    const restore = stubTerminal();
    try { await main(['node', 'lping']); } finally { restore(); }
    expect(stdout).toContain('synthetic-17');
    expect(process.exitCode).toBe(0);
  });

  it('reports invalid enrollment JSON without echoing its content', async () => {
    const input = join(directory, 'enrollment.json');
    await writeFile(input, 'private-run-notes {');
    await main(['node', 'lping', 'bank-create', '--input', input, '--output', join(directory, 'bank.json')]);
    expect(stderr).toContain('Enrollment input is not valid JSON');
    expect(stderr).not.toContain('private-run-notes');
    expect(process.exitCode).toBe(1);
  });

  it('does not allow --allow-transport-mismatch to bypass the sample budget', async () => {
    await main(['node', 'lping', '--driver', 'codex', '--allow-transport-mismatch', '--samples', '64', '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ERROR', error: expect.stringContaining('samples=64 (bank: 128)') });
    expect(fake.requests).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  it('selects the bundled pooled bank with --pooled', async () => {
    vi.stubEnv('LOGITPING_API_KEY', 'tool-key');
    vi.spyOn(bankLoader, 'pooledBank').mockResolvedValue(openEnvelopes(syntheticPooledBank()));
    const fetch = lowRangeEndpoint();
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--pooled', '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'HEURISTIC_MATCH', model: 'synthetic-1-120', candidates: ['synthetic-1-120'], requests: 4 });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(process.exitCode).toBe(2);
  });

  it('prints the candidates and request count of a pooled result', async () => {
    vi.stubEnv('LOGITPING_API_KEY', 'tool-key');
    vi.spyOn(bankLoader, 'pooledBank').mockResolvedValue(forceCutoffs(openEnvelopes(syntheticPooledBank()), [true, true, false]));
    lowRangeEndpoint();
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--pooled']);
    expect(stdout).toContain('Inconclusive, consistent with: synthetic-1-120, synthetic-118-237');
    expect(stdout).toContain('256/256 integers in 4 requests');
    expect(stdout).toContain('fit pass · margin pass');
    expect(process.exitCode).toBe(2);
  });

  it('exits with code 2 when no enrolled model fits a pooled probe', async () => {
    vi.stubEnv('LOGITPING_API_KEY', 'tool-key');
    vi.spyOn(bankLoader, 'pooledBank').mockResolvedValue(forceCutoffs(openEnvelopes(syntheticPooledBank()), [false, false, false]));
    lowRangeEndpoint();
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--pooled', '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'UNKNOWN_MODEL', model: null, candidates: [], requests: 4 });
    expect(process.exitCode).toBe(2);
  });

  it('streams each pooled reply on its own line', async () => {
    vi.stubEnv('LOGITPING_API_KEY', 'tool-key');
    vi.spyOn(bankLoader, 'pooledBank').mockResolvedValue(openEnvelopes(syntheticPooledBank()));
    lowRangeEndpoint();
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--pooled', '--stream', '--json']);
    // ora prints its text once when the spinner is disabled.
    expect(stderr).toBe(`- Running fingerprint probes…\n${Array.from({ length: 4 }, (_, run) => `${syntheticRun(1, 120, run).join(' ')} `).join('\n')}\n`);
  });

  it('rejects --pooled together with --bank before any request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--pooled', '--bank', join(directory, 'bank.json'), '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ERROR', error: 'Choose either --pooled or --bank' });
    expect(fetch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [['--driver', 'codex'], 'transport=codex (bank: openai)'],
    [['--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--samples', '512'], 'samples=512 (bank: 64)'],
  ])('checks the pooled bank protocol before any request (%#)', async (args, message) => {
    vi.spyOn(bankLoader, 'pooledBank').mockResolvedValue(syntheticPooledBank());
    const fetch = vi.spyOn(globalThis, 'fetch');
    await main(['node', 'lping', ...args, '--pooled', '--no-tokenizer', '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ERROR', code: 'PROTOCOL_MISMATCH', error: expect.stringContaining(message) });
    expect(fetch).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(0);
  });

  it('creates a pooled bank when the enrollment input sets pooled scoring', async () => {
    const input = join(directory, 'enrollment.json');
    const output = join(directory, 'pooled-bank.json');
    await writeFile(input, JSON.stringify({ ...syntheticEnrollment(), scoring: 'pooled-sets-v1', requestsPerProbe: 4 }));
    await main(['node', 'lping', 'bank-create', '--input', input, '--output', output]);
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({ schemaVersion: 2, protocol: { requestsPerProbe: 4, scoring: 'pooled-sets-v1' } });
  });

  it('refuses requestsPerProbe without pooled scoring in enrollment input', async () => {
    const input = join(directory, 'enrollment.json');
    await writeFile(input, JSON.stringify({ ...syntheticEnrollment(), requestsPerProbe: 4 }));
    await main(['node', 'lping', 'bank-create', '--input', input, '--output', join(directory, 'bank.json')]);
    expect(stderr).toContain('Set scoring and requestsPerProbe together');
    expect(process.exitCode).toBe(1);
  });

  it('offers the experimental pooled bank when the interactive bank path is blank', async () => {
    vi.stubEnv('LOGITPING_API_KEY', 'tool-key');
    vi.spyOn(bankLoader, 'pooledBank').mockResolvedValue(openEnvelopes(syntheticPooledBank()));
    const fetch = lowRangeEndpoint();
    prompts.answers.push('api', 'openai', 'https://proxy.example/v1', 'claimed', undefined, true);
    const restore = stubTerminal();
    try { await main(['node', 'lping']); } finally { restore(); }
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(stdout).toContain('Heuristic match: synthetic-1-120');
  });

  it('keeps --pooled in interactive mode without asking for a bank', async () => {
    vi.stubEnv('LOGITPING_API_KEY', 'tool-key');
    vi.spyOn(bankLoader, 'pooledBank').mockResolvedValue(openEnvelopes(syntheticPooledBank()));
    const fetch = lowRangeEndpoint();
    prompts.answers.push('api', 'openai', 'https://proxy.example/v1', 'claimed', 'unread');
    const restore = stubTerminal();
    try { await main(['node', 'lping', '--pooled']); } finally { restore(); }
    expect(prompts.answers).toEqual(['unread']);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(stdout).toContain('Heuristic match: synthetic-1-120');
  });

  it('keeps a --bank path in interactive mode without asking for another', async () => {
    const bank = syntheticBank();
    bank.protocol.transport = 'codex';
    const path = join(directory, 'codex-bank.json');
    await writeFile(path, JSON.stringify(bank));
    prompts.answers.push('codex', 'unread');
    const restore = stubTerminal();
    try { await main(['node', 'lping', '--bank', path]); } finally { restore(); }
    expect(prompts.answers).toEqual(['unread']);
    expect(stdout).toContain('synthetic-17');
    expect(process.exitCode).toBe(0);
  });
});

describe('API key scoping', () => {
  const vendor = { OPENAI_API_KEY: 'vendor-openai', ANTHROPIC_API_KEY: 'vendor-anthropic' };
  it.each([
    [{ provider: 'openai', endpoint: 'https://api.openai.com/v1' }, vendor, 'vendor-openai'],
    [{ provider: 'anthropic', endpoint: 'https://api.anthropic.com' }, vendor, 'vendor-anthropic'],
    [{ provider: 'openai', endpoint: 'https://proxy.example/v1' }, vendor, undefined],
    [{ provider: 'openai', endpoint: 'https://api.openai.com.proxy.example/v1' }, vendor, undefined],
    [{ provider: 'anthropic', endpoint: 'https://api.openai.com/v1' }, vendor, undefined],
    [{ provider: 'openai', endpoint: 'not a url' }, vendor, undefined],
    [{ provider: 'openai', endpoint: 'http://api.openai.com/v1' }, vendor, undefined],
    [{ provider: 'openai', endpoint: 'https://proxy.example/v1' }, { ...vendor, LOGITPING_API_KEY: 'tool-key' }, 'tool-key'],
    [{ provider: 'openai', endpoint: 'https://proxy.example/v1', key: 'flag-key' }, { ...vendor, LOGITPING_API_KEY: 'tool-key' }, 'flag-key'],
  ])('resolves %j', (options, env, expected) => {
    expect(resolveApiKey(options, env)).toBe(expected);
  });
});
