import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AntigravityDriver, AntigravityEventDecoder } from '../src/drivers/antigravity_driver.js';
import { CliDriver, type DriverOptions } from '../src/drivers/base.js';
import { ClaudeDriver, ClaudeEventDecoder } from '../src/drivers/claude_driver.js';
import { CodexDriver, CodexEventDecoder } from '../src/drivers/codex_driver.js';

/** Events in the shape agy 1.4.2 emits with `--output-format stream-json`. */
const conversation = '9d16bde6-7312-4229-b357-b6fbfd26bfa6';
const agyInit = (fields: Record<string, unknown> = {}) => ({
  event: 'init', conversation_id: conversation,
  init: { model: 'gemini-3.8-flash-low', cwd: '/tmp/logitping-x', tools: ['run_command', 'view_file'], permission_mode: 'request-review', ...fields },
});
const agyStep = (fields: Record<string, unknown>) => ({
  event: 'step_update', step_update: { conversation_id: conversation, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', ...fields },
});
const agyResult = (fields: Record<string, unknown> = {}) => ({
  event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: '17 355 42\n', num_turns: 1, ...fields },
});
/** A decoder that has accepted the init event. */
const startedAgy = () => {
  const decoder = new AntigravityEventDecoder();
  decoder.decode(agyInit());
  return decoder;
};

describe('CLI event decoders', () => {
  it('takes Claude partial text exactly once and excludes metadata and nested agents', () => {
    const decoder = new ClaudeEventDecoder();
    const delta = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '17 ' } } };
    expect(decoder.decode({ type: 'system', model: 'claimed', usage: 355 })).toEqual([]);
    expect(decoder.decode({ ...delta, parent_tool_use_id: 'nested' })).toEqual([]);
    expect(decoder.decode(delta)).toEqual(['17 ']);
    expect(decoder.decode({ type: 'assistant', message: { content: [{ type: 'text', text: '17 ' }] } })).toEqual([]);
    expect(decoder.decode({ type: 'result', subtype: 'success', result: '17 ' })).toEqual([]);
    expect(() => decoder.finish()).not.toThrow();
  });
  it('supports Claude result fallback and catches errors and truncation', () => {
    const decoder = new ClaudeEventDecoder();
    expect(decoder.decode({ type: 'result', subtype: 'success', result: '355' })).toEqual(['355']);
    expect(() => new ClaudeEventDecoder().finish()).toThrow();
    expect(() => decoder.decode({ type: 'result', is_error: true })).toThrow();
  });
  it.each([
    ['tool_use start', { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't', name: 'Bash', input: {} } } }],
    ['server_tool_use start', { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 't', name: 'web_search', input: {} } } }],
    ['assistant tool_use', { type: 'assistant', message: { content: [{ type: 'text', text: '17' }, { type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }],
    ['nested tool_use', { type: 'assistant', parent_tool_use_id: 'p', message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } }],
    ['tool_result', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'output' }] } }],
  ])('aborts as soon as Claude emits a %s block', (_label, event) => {
    expect(() => new ClaudeEventDecoder().decode(event)).toThrow(expect.objectContaining({
      code: 'CLI_FAILED', message: 'Claude attempted a tool action during the probe; aborted',
    }));
  });
  it('accepts Claude text block starts', () => {
    const decoder = new ClaudeEventDecoder();
    expect(decoder.decode({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })).toEqual([]);
  });
  it('accepts only completed Codex agent messages once', () => {
    const decoder = new CodexEventDecoder();
    expect(decoder.decode({ type: 'item.completed', item: { type: 'reasoning', text: '23' } })).toEqual([]);
    const item = { type: 'agent_message', id: 'a', text: '17 355' };
    expect(decoder.decode({ type: 'item.updated', item })).toEqual([]);
    expect(decoder.decode({ type: 'item.completed', item })).toEqual(['17 355']);
    expect(decoder.decode({ type: 'item.completed', item })).toEqual([]);
    decoder.decode({ type: 'turn.completed' });
    expect(() => decoder.finish()).not.toThrow();
    expect(() => decoder.decode({ type: 'turn.failed' })).toThrow();
  });
  it.each(['command_execution', 'file_change', 'mcp_tool_call', 'web_search', undefined])('aborts as soon as Codex starts a %s item', (type) => {
    for (const phase of ['item.started', 'item.updated', 'item.completed']) {
      expect(() => new CodexEventDecoder().decode({ type: phase, item: { type, text: '42' } })).toThrow('Codex attempted a tool action during the probe');
    }
  });
  it('takes Antigravity response deltas exactly once and excludes metadata', () => {
    const decoder = new AntigravityEventDecoder();
    expect(decoder.decode(agyInit())).toEqual([]);
    expect(decoder.decode(agyStep({ step_index: 0, state: 'DONE', step_type: 'user_input' }))).toEqual([]);
    expect(decoder.decode(agyStep({ text_delta: '17' }))).toEqual(['17']);
    expect(decoder.decode(agyStep({ text_delta: ' 355 42' }))).toEqual([' 355 42']);
    expect(decoder.decode(agyStep({ state: 'DONE', text_delta: '\n', usage: { output_tokens: 9, thinking_tokens: 0 } }))).toEqual(['\n']);
    expect(decoder.decode(agyResult())).toEqual([]);
    expect(() => decoder.finish()).not.toThrow();
  });
  it('falls back to the Antigravity result text and catches errors and truncation', () => {
    const decoder = startedAgy();
    // A response step that only reasoned streams no text.
    expect(decoder.decode(agyStep({ state: 'DONE', usage: { output_tokens: 869, thinking_tokens: 750 } }))).toEqual([]);
    expect(decoder.decode(agyResult({ response: '355' }))).toEqual(['355']);
    expect(() => new AntigravityEventDecoder().finish()).toThrow('Antigravity output ended before its result event');
    expect(() => startedAgy().decode(agyResult({ status: 'ERROR', response: '', error: 'quota' }))).toThrow('Antigravity reported an unsuccessful probe');
    expect(() => startedAgy().decode(agyStep({ state: 'ERROR' }))).toThrow('Antigravity reported an unsuccessful probe');
    // agy reports a rejected prompt in a result without an init event.
    expect(() => new AntigravityEventDecoder().decode(agyResult({ status: 'ERROR', response: '' }))).toThrow('Antigravity reported an unsuccessful probe');
  });
  it('ignores Antigravity text from another conversation', () => {
    const decoder = startedAgy();
    const nested = agyStep({ text_delta: '42' });
    nested.step_update.conversation_id = 'nested-conversation';
    expect(decoder.decode(nested)).toEqual([]);
    expect(decoder.decode(agyStep({ text_delta: '17' }))).toEqual(['17']);
  });
  it.each([
    ['a command', { step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls -la' } } }],
    ['a file read', { step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: '/tmp/note.txt' } } }],
    ['an MCP call', { step_type: 'tool', tool_name: 'call_mcp_tool' }],
    ['a step of an unknown type', { step_type: 'browser_action' }],
    ['a step without a type', { step_type: undefined }],
  ])('aborts as soon as Antigravity starts %s', (_label, fields) => {
    // Tool steps report ACTIVE before they run; read-only tools then finish without a permission prompt.
    expect(() => startedAgy().decode(agyStep({ step_index: 2, ...fields }))).toThrow(expect.objectContaining({
      code: 'CLI_FAILED', message: 'Antigravity attempted a tool action during the probe; aborted',
    }));
  });
  it('aborts when Antigravity reports a denied tool action', () => {
    const denied = agyResult({ response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] });
    expect(() => startedAgy().decode(denied)).toThrow('Antigravity attempted a tool action during the probe; aborted');
  });
  it.each(['bypass-permissions', 'auto', undefined])('refuses to sample Antigravity in permission mode %s', (mode) => {
    // Only request-review denies tools that need a permission prompt in headless mode.
    expect(() => new AntigravityEventDecoder().decode(agyInit({ permission_mode: mode }))).toThrow(expect.objectContaining({ code: 'CLI_FAILED', message: expect.stringContaining('request-review') }));
  });
  it('refuses Antigravity steps that arrive before its init event', () => {
    expect(() => new AntigravityEventDecoder().decode(agyStep({ text_delta: '17' }))).toThrow('Antigravity output did not start with its init event');
  });
  /** A caller mistake: a TypeError from the model check, before any process starts. */
  const rejectsModel = (model: string) => {
    for (const Driver of [ClaudeDriver, CodexDriver, AntigravityDriver]) {
      expect(() => new Driver({ model })).toThrow(TypeError);
      expect(() => new Driver({ model })).toThrow(/^CLI model must/);
    }
  };
  it('rejects CLI model values that a child parser could read as flags', () => {
    for (const model of ['--dangerously-skip-permissions', '-x', '', ' model', 'two words', 'line\nbreak']) rejectsModel(model);
    for (const model of ['opus', 'claude-opus-5-5[1m]', 'gpt-5.5-codex', 'claude-sonnet-4@20250514', 'us.anthropic.claude-opus-5:0', 'openai/gpt-oss-120b']) {
      expect(() => new ClaudeDriver({ model })).not.toThrow();
      expect(() => new CodexDriver({ model })).not.toThrow();
    }
  });
  // On Windows an npm-installed CLI is a .cmd shim: cmd.exe parses its arguments again, so a quote
  // followed by & | < > runs a command (cross-spawn escapes only node_modules\.bin shims twice).
  it.each(['x"&calc&"', 'a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a%PATH%', 'a!b', 'a;b', 'a,b', 'a`b', 'a(b)', 'a*b', 'a?b'])(
    'rejects the model %s, which cmd.exe would interpret when it reparses a Windows shim', rejectsModel,
  );
  it('uses safe noninteractive flags and preserves literal model arguments', () => {
    class Claude extends ClaudeDriver { command() { return this.args(); } }
    class Codex extends CodexDriver { command() { return this.args(); } }
    const model = 'claude-opus-5-5[1m]';
    const args = new Claude({ model }).command();
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', model]);
    expect(new Claude().command()).toContain('--include-partial-messages');
    expect(new Codex().command()).toContain('read-only');
    expect(new Codex().granularity).toBe('message');
  });
  it('runs Antigravity headless over stream-json without auto-approving tools', () => {
    class Agy extends AntigravityDriver { command() { return this.args(); } }
    const args = new Agy({ model: 'gemini-3.8-flash-low' }).command();
    for (const flag of ['--input-format', '--output-format']) expect(args[args.indexOf(flag) + 1]).toBe('stream-json');
    expect(args).toEqual(expect.arrayContaining(['--sandbox', '--disable-slash-commands']));
    // -p takes the prompt as an argument; the prompt goes to stdin instead.
    for (const flag of ['-p', '--print', '--prompt', '--dangerously-skip-permissions', '--mode']) expect(args).not.toContain(flag);
    expect(args.slice(-2)).toEqual(['--model', 'gemini-3.8-flash-low']);
    expect(new Agy().command()).not.toContain('--model');
    expect(new Agy().name).toBe('antigravity');
  });
  it('turns off Codex tool features with config overrides that unknown names cannot break', () => {
    class Codex extends CodexDriver { command() { return this.args(); } }
    const args = new Codex({ model: 'gpt-5.5-codex' }).command();
    for (const feature of ['shell_tool', 'unified_exec', 'view_image', 'browser_use', 'computer_use', 'apps', 'plugins', 'multi_agent', 'hooks']) {
      expect(args[args.indexOf(`features.${feature}=false`) - 1]).toBe('-c');
    }
    // `--disable <name>` exits on names an installed Codex version does not know; `-c` ignores them.
    expect(args).not.toContain('--disable');
    expect(args.slice(-3)).toEqual(['--model', 'gpt-5.5-codex', '-']);
  });
});

describe('real subprocess lifecycle using a local fake CLI', () => {
  let directory: string;
  let script: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'lping-tests-'));
    script = join(directory, 'fake.cjs');
    await writeFile(script, `
const mode = process.argv[2];
if (mode === 'failure') process.exit(3);
if (mode === 'tool') {
  // A Codex backend that answers once, then starts a shell command and waits for its result.
  const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
  send({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: String(process.pid) } });
  send({ type: 'item.started', item: { id: 'b', type: 'command_execution', command: 'cat ~/.ssh/id_rsa' } });
  setInterval(() => {}, 100);
}
if (mode === 'oversized') { process.stdout.write('x'.repeat(1_100_000)); setInterval(() => {}, 100); }
else if (mode === 'malformed') { process.stdout.write('not JSON\\n'); setInterval(() => {}, 100); }
else if (mode === 'env') {
  // Report which of the probe's variables this CLI process can read, then finish normally.
  const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
  const { LOGITPING_API_KEY: key = null, logitping_api_key: lower = null, LOGITPING_TEST_MARKER: marker = null } = process.env;
  send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: JSON.stringify({ key, lower, marker }) } } });
  send({ type: 'result', subtype: 'success' });
}
else {
  if (mode === 'stubborn') process.on('SIGTERM', () => {});
  const send = text => process.stdout.write(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text}}})+'\\n');
  send(String(process.pid));
  setInterval(() => {}, 100);
}
`);
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
  afterEach(() => { vi.unstubAllEnvs(); });

  class FakeDriver extends CliDriver {
    readonly name = 'claude' as const;
    readonly granularity = 'token' as const;
    constructor(private readonly mode: string, options: Omit<DriverOptions, 'binary'> = {}) { super({ ...options, binary: process.execPath }); }
    protected args() { return [script, this.mode]; }
    protected decoder() { return new ClaudeEventDecoder(); }
  }

  async function reply(driver: CliDriver): Promise<unknown> {
    const texts: string[] = [];
    for await (const text of driver.stream({ prompt: 'test', maxTokens: 10 })) texts.push(text);
    return JSON.parse(texts.join(''));
  }

  it('withholds the API-mode key, in any letter case, and keeps the rest of the environment', async () => {
    // A tool call racing the abort could read the CLI's environment and return it to the backend under test.
    vi.stubEnv('LOGITPING_API_KEY', 'api-mode-secret');
    vi.stubEnv('logitping_api_key', 'api-mode-secret');
    vi.stubEnv('LOGITPING_TEST_MARKER', 'inherited');
    expect(await reply(new FakeDriver('env'))).toEqual({ key: null, lower: null, marker: 'inherited' });
  });
  it('gives the CLI exactly the environment a caller supplies', async () => {
    vi.stubEnv('LOGITPING_TEST_MARKER', 'inherited');
    const env = { PATH: process.env.PATH, LOGITPING_API_KEY: 'deliberately-passed' };
    expect(await reply(new FakeDriver('env', { env }))).toEqual({ key: 'deliberately-passed', lower: null, marker: null });
  });

  it.each(['normal', 'stubborn'])('terminates a %s child when consumption stops', async (mode) => {
    const stream = new FakeDriver(mode).stream({ prompt: 'only this probe', maxTokens: 100 });
    const { value } = await stream.next();
    const pid = Number(value);
    expect(pid).toBeGreaterThan(1);
    await stream.return(undefined);
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('kills a Codex child that starts a tool action', async () => {
    class FakeCodex extends CliDriver {
      readonly name = 'codex';
      readonly granularity = 'message' as const;
      constructor() { super({ binary: process.execPath }); }
      protected args() { return [script, 'tool']; }
      protected decoder() { return new CodexEventDecoder(); }
    }
    const stream = new FakeCodex().stream({ prompt: 'test', maxTokens: 10 });
    const pid = Number((await stream.next()).value);
    await expect(stream.next()).rejects.toMatchObject({ code: 'CLI_FAILED', message: expect.stringContaining('tool action') });
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('propagates nonzero exits, malformed events, and missing executables', async () => {
    await expect(new FakeDriver('failure').stream({ prompt: 'test', maxTokens: 1 }).next()).rejects.toThrow('probe failed');
    await expect(new FakeDriver('malformed').stream({ prompt: 'test', maxTokens: 1 }).next()).rejects.toThrow('malformed JSONL');
    await expect(new ClaudeDriver({ binary: join(directory, 'missing') }).stream({ prompt: 'test', maxTokens: 1 }).next()).rejects.toMatchObject({ code: 'CLI_NOT_FOUND', message: expect.stringContaining('not found') });
  });
  it.each([
    ['malformed', 'claude emitted malformed JSONL'],
    ['oversized', 'CLI event exceeded 1 MiB'],
  ])('reports %s CLI output as CLI_FAILED', async (mode, message) => {
    await expect(new FakeDriver(mode).stream({ prompt: 'test', maxTokens: 1 }).next()).rejects.toMatchObject({ code: 'CLI_FAILED', message });
  });
  it('terminates a waiting child when externally aborted', async () => {
    const controller = new AbortController();
    const stream = new FakeDriver('normal').stream({ prompt: 'test', maxTokens: 10, signal: controller.signal });
    const { value } = await stream.next();
    const pending = stream.next();
    controller.abort(new Error('test abort'));
    await expect(pending).rejects.toThrow('test abort');
    expect(() => process.kill(Number(value), 0)).toThrow();
  });

  // Runs the real CodexDriver against an executable fake: `mcp list --json` prints FAKE_MCP, and
  // `exec` records that it started, then replies with its own argument list.
  describe.skipIf(process.platform === 'win32')('Codex MCP isolation', () => {
    let codex: string;
    beforeAll(async () => {
      codex = join(directory, 'fake-codex.cjs');
      await writeFile(codex, `#!${process.execPath}
const args = process.argv.slice(2);
const listing = process.env.FAKE_MCP ?? '[]';
if (args[0] === 'mcp') {
  if (listing === 'fail') process.exit(1);
  if (listing === 'hang') setInterval(() => {}, 100);
  else process.stdout.write(listing);
} else {
  if (process.env.FAKE_EXEC_MARKER) require('node:fs').writeFileSync(process.env.FAKE_EXEC_MARKER, '');
  const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
  send({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: JSON.stringify(args) } });
  send({ type: 'turn.completed' });
}
`, { mode: 0o755 });
    });
    let markers = 0;
    const driver = (listing: string, marker?: string) =>
      new CodexDriver({ binary: codex, env: { ...process.env, FAKE_MCP: listing, ...(marker ? { FAKE_EXEC_MARKER: marker } : {}) } });

    it('disables each enabled MCP server by name, since an empty mcp_servers override merges into nothing', async () => {
      const listing = JSON.stringify([{ name: 'fs', enabled: true }, { name: 'off', enabled: false }, { name: 'remote-1', enabled: true }]);
      const args = await reply(driver(listing)) as string[];
      for (const name of ['fs', 'remote-1']) expect(args[args.indexOf(`mcp_servers.${name}.enabled=false`) - 1]).toBe('-c');
      expect(args.join(' ')).not.toContain('mcp_servers.off');
      expect(args.at(-1)).toBe('-');
    });
    it.each([
      ['an enabled server whose name a dotted override cannot address', JSON.stringify([{ name: 'dot.ted', enabled: true }])],
      ['a server without a name', JSON.stringify([{ enabled: true }])],
      ['output that is not a server list', 'not JSON'],
      ['a failed listing', 'fail'],
    ])('refuses to start Codex after %s', async (_label, listing) => {
      const marker = join(directory, `exec-started-${++markers}`);
      await expect(reply(driver(listing, marker))).rejects.toMatchObject({ code: 'CLI_FAILED' });
      expect(existsSync(marker)).toBe(false);
    });
    it('stops a hung MCP listing when aborted', async () => {
      const controller = new AbortController();
      const pending = driver('hang').stream({ prompt: 'test', maxTokens: 10, signal: controller.signal }).next();
      setTimeout(() => controller.abort(new Error('test abort')), 200);
      await expect(pending).rejects.toThrow('test abort');
    });
    it('still reports a missing Codex executable as CLI_NOT_FOUND', async () => {
      await expect(new CodexDriver({ binary: join(directory, 'missing') }).stream({ prompt: 'test', maxTokens: 1 }).next())
        .rejects.toMatchObject({ code: 'CLI_NOT_FOUND' });
    });
  });

  // Runs the real AntigravityDriver against an executable fake named agy: it replies with its
  // argument list and standard input, or with FAKE_AGY=tool answers once and then starts a tool.
  describe.skipIf(process.platform === 'win32')('Antigravity subprocess', () => {
    let bin: string;
    beforeAll(async () => {
      bin = join(directory, 'agy-bin');
      await mkdir(bin);
      await writeFile(join(bin, 'agy'), `#!${process.execPath}
const args = process.argv.slice(2);
const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
const step = fields => send({ event: 'step_update', step_update: { conversation_id: 'c', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', ...fields } });
let input = '';
process.stdin.on('data', chunk => { input += chunk; }).on('end', () => {
  send({ event: 'init', conversation_id: 'c', init: { tools: ['view_file'], permission_mode: 'request-review' } });
  if (process.env.FAKE_AGY === 'tool') {
    step({ text_delta: String(process.pid) });
    step({ step_index: 2, step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: '/etc/hosts' } } });
    setInterval(() => {}, 100);
    return;
  }
  step({ state: 'DONE', text_delta: JSON.stringify({ args, input }) });
  send({ event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: '' } });
});
`, { mode: 0o755 });
    });
    /** The default executable name, found on PATH like an installed agy. */
    const agy = (mode = 'reply') => new AntigravityDriver({ env: { PATH: bin, FAKE_AGY: mode } });

    it('starts agy from PATH and sends the prompt as one stream-json user message', async () => {
      const prompt = 'Line one\n"quoted" \\ {"event":"user"}';
      const texts: string[] = [];
      for await (const text of agy().stream({ prompt, maxTokens: 10 })) texts.push(text);
      const { args, input } = JSON.parse(texts.join('')) as { args: string[]; input: string };
      expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json');
      expect(input.endsWith('\n')).toBe(true);
      expect(input.trimEnd().split('\n').map((line) => JSON.parse(line))).toEqual([{ event: 'user', message: { content: prompt } }]);
    });
    it('kills agy when it starts a tool', async () => {
      const stream = agy('tool').stream({ prompt: 'test', maxTokens: 10 });
      const pid = Number((await stream.next()).value);
      await expect(stream.next()).rejects.toMatchObject({ code: 'CLI_FAILED', message: expect.stringContaining('tool action') });
      expect(() => process.kill(pid, 0)).toThrow();
    });
    it('names the agy executable when it is missing', async () => {
      await expect(new AntigravityDriver({ env: { PATH: join(directory, 'empty') } }).stream({ prompt: 'test', maxTokens: 1 }).next())
        .rejects.toMatchObject({ code: 'CLI_NOT_FOUND', message: expect.stringMatching(/^agy was not found on PATH/) });
    });
  });
});
