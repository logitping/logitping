import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, resolveApiKey } from '../src/cli.js';
import type { ProbeRequest } from '../src/core/types.js';
import * as bankLoader from '../src/data/bank_loader.js';
import { syntheticBank } from './fixtures.js';

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
