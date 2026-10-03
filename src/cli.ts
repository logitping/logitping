import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import * as prompts from '@clack/prompts';
import pc from 'picocolors';
import ora from 'ora';
import { HttpClient, type ApiFormat, type TokenLimitField } from './core/client.js';
import { fingerprint } from './core/engine.js';
import { LogitpingError } from './core/errors.js';
import type { Language, ProbeResult, ProbeTransport, Provider } from './core/types.js';
import { loadBank } from './data/bank_loader.js';
import { createFingerprintBank, type EnrollmentInput } from './data/enrollment.js';
import { ClaudeDriver } from './drivers/claude_driver.js';
import { CodexDriver } from './drivers/codex_driver.js';
import { readBoundedText } from './util/fs.js';
import { MAX_PAYLOAD_BYTES, MAX_SAMPLES, MIN_SAMPLES } from './util/validate.js';
import pkg from '../package.json';

interface Options {
  driver?: string;
  endpoint?: string;
  provider: string;
  key?: string;
  keyFile?: string;
  model?: string;
  bank?: string;
  samples?: number;
  temperature?: number;
  language?: string;
  timeout: number;
  tokenizer?: boolean;
  earlyStop: boolean;
  stream: boolean;
  json: boolean;
  allowInsecureHttp: boolean;
  allowTransportMismatch: boolean;
  apiFormat?: string;
  tokenLimitField?: string;
  maxTokens?: number;
}

function positiveInteger(raw: string): number {
  const number = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(number) || number < 1) throw new InvalidArgumentError('Expected a positive integer');
  return number;
}

function temperatureValue(raw: string): number {
  const number = Number(raw);
  if (!raw.trim() || !Number.isFinite(number) || number < 0 || number > 2) throw new InvalidArgumentError('Temperature must be between 0 and 2');
  return number;
}

function answer<T>(value: T | symbol): T {
  if (prompts.isCancel(value)) throw new Error('Cancelled');
  return value as T;
}

async function interactive(options: Options): Promise<void> {
  prompts.intro(pc.bold('logitping · LLM fingerprint probes'));
  const mode = answer(await prompts.select({ message: 'Which connection should be tested?', options: [
    { value: 'claude', label: 'Claude Code', hint: 'uses your local login' },
    { value: 'codex', label: 'Codex', hint: 'uses your local login' },
    { value: 'api', label: 'API endpoint' },
  ] }));
  if (mode !== 'api') options.driver = mode;
  else {
    options.provider = answer(await prompts.select({ message: 'API format', options: [
      { value: 'openai', label: 'OpenAI compatible' }, { value: 'anthropic', label: 'Anthropic Messages' },
    ] }));
    options.endpoint = answer(await prompts.text({ message: 'Base URL', placeholder: options.provider === 'openai' ? 'https://api.openai.com' : 'https://api.anthropic.com', validate: (value) => { try { new URL(value); } catch { return 'Enter a full URL'; } } }));
    options.model = answer(await prompts.text({ message: 'Claimed model identifier', validate: (value) => !value.trim() ? 'Enter a model identifier' : undefined }));
    if (!options.keyFile && !resolveApiKey(options)) options.key = answer(await prompts.password({ message: 'API key (leave blank for an unauthenticated local endpoint)' }));
  }
  const bank = answer(await prompts.text({ message: options.allowTransportMismatch
    ? 'Reference bank path (blank uses the bundled bank for experimental comparison)'
    : 'Fingerprint bank path (blank uses the bundled bank when its transport matches; otherwise collects without identification)' }));
  if (bank.trim()) options.bank = bank.trim();
}

const VENDOR_KEYS = {
  openai: { variable: 'OPENAI_API_KEY', host: 'api.openai.com' },
  anthropic: { variable: 'ANTHROPIC_API_KEY', host: 'api.anthropic.com' },
} as const satisfies Record<Provider, { variable: string; host: string }>;

/** Only HTTPS to the vendor's own host may receive that vendor's key, even with --allow-insecure-http. */
function vendorEndpoint(endpoint: string | undefined, host: string): boolean {
  try { const url = new URL(endpoint ?? ''); return url.protocol === 'https:' && url.hostname === host; } catch { return false; }
}

/**
 * Explicit keys go to any endpoint. A vendor's own environment key goes only to that vendor's
 * host, never to a third-party endpoint under test.
 */
export function resolveApiKey(options: Pick<Options, 'key' | 'endpoint' | 'provider'>, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (options.key) return options.key;
  if (env.LOGITPING_API_KEY) return env.LOGITPING_API_KEY;
  const vendor = VENDOR_KEYS[options.provider as Provider];
  return vendor && vendorEndpoint(options.endpoint, vendor.host) ? env[vendor.variable] || undefined : undefined;
}

/**
 * A key file keeps the secret out of argv and shell history; surrounding whitespace is trimmed.
 * Pipes work too, such as --key-file <(pass show api-key) or /dev/stdin.
 */
async function readKeyFile(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() && !info.isFIFO() && !info.isCharacterDevice()) throw new Error('Key file must be a regular file or a pipe');
  const chunks: Buffer[] = [];
  let size = 0;
  // Counted while reading: a pipe or device has no size to check in advance.
  for await (const chunk of createReadStream(path, { highWaterMark: 1_024 })) {
    size += (chunk as Buffer).length;
    if (size > 4_096) throw new Error('Key file must be no larger than 4 KiB');
    chunks.push(chunk as Buffer);
  }
  const key = Buffer.concat(chunks).toString('utf8').trim();
  if (!key) throw new Error('Key file is empty');
  return key;
}

/** Machine-readable fields for --json errors: a LogitpingError code and HTTP status, or a deadline. */
function errorDetails(error: unknown): { code?: string; httpStatus?: number } {
  if (error instanceof LogitpingError) return { code: error.code, ...(error.status !== undefined ? { httpStatus: error.status } : {}) };
  return error instanceof Error && error.name === 'TimeoutError' ? { code: 'TIMEOUT' } : {};
}

function withheldKeyNote(options: Options): string | undefined {
  const vendor = VENDOR_KEYS[options.provider as Provider];
  if (!vendor || !process.env[vendor.variable]) return undefined;
  return `${vendor.variable} is only sent to https://${vendor.host}; set LOGITPING_API_KEY or --key to authenticate to this endpoint.`;
}

/** Never pass terminal escape sequences or bidirectional overrides from endpoint output to the terminal. */
function safeText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}

function display(result: ProbeResult): void {
  const label = result.status === 'HEURISTIC_MATCH' ? `Heuristic match: ${result.model}` : result.model ?? result.status;
  process.stdout.write(`\n${pc.bold(label)}\n${result.reason}\n`);
  if (result.confidence !== null) process.stdout.write(`Nominal model-relative confidence: ${(result.confidence * 100).toFixed(2)}%\n`);
  for (const score of [...result.scores].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))) {
    process.stdout.write(`  ${score.id}: ${score.weight === null ? 'unranked' : `${(score.weight * 100).toFixed(2)}%`} · H=${score.hellinger.toFixed(4)} · M=${score.mahalanobis.toFixed(2)} · OOD ${score.accepted ? 'pass' : 'reject'}\n`);
  }
  process.stdout.write(`${result.samples.length}/${result.requestedSamples} integers · ${result.elapsedMs} ms\n`);
  process.stdout.write(result.earlyStopped
    ? `Stopped early: ${(result.sampleBudgetSaved * 100).toFixed(1)}% of the requested integer budget skipped (not measured token or latency savings).\n`
    : 'Early stop: no\n');
  for (const warning of result.warnings) process.stdout.write(`${pc.yellow('Note:')} ${warning}\n`);
}

export async function main(argv = process.argv): Promise<void> {
  // Read before parsing: a parser error can stop commander before it reaches --json.
  const jsonRequested = argv.slice(2).includes('--json');
  const program = new Command()
    .name('logitping')
    .description('Probe LLM behavior via API, Claude Code, or Codex. Alias: lping.')
    .version(pkg.version)
    // Throw instead of calling process.exit(): --json failures stay JSON, and main() always returns.
    // Set before .command() so that subcommands inherit both settings.
    .exitOverride()
    .configureOutput({ outputError: (text, write) => { if (!jsonRequested) write(text); } })
    .option('--driver <name>', 'local CLI driver: claude or codex')
    .option('--endpoint <url>', 'API base URL or complete completion endpoint')
    .option('--provider <name>', 'API format: openai or anthropic', 'openai')
    .option('--key <key>', 'API key; visible in process listings and shell history (prefer --key-file or LOGITPING_API_KEY)')
    .option('--key-file <path>', 'read the API key from a file or pipe, e.g. <(pass show key) (API only)')
    .option('--model <id>', 'claimed API model or optional CLI model override')
    .option('--api-format <format>', 'OpenAI wire format: chat-completions (default) or responses')
    .option('--token-limit-field <name>', 'API budget field: max_tokens, max_completion_tokens, or max_output_tokens (default depends on the API format)')
    .option('--max-tokens <count>', 'output token budget for the integer request (default: samples × 5 + 64); reasoning models need more', positiveInteger)
    .option('--bank <path>', 'measured bank matching this transport (default: compatible bundled bank, otherwise collection only)')
    .option('--allow-transport-mismatch', 'experimentally compare against another transport\'s bank; no validated identity or early stopping', false)
    .option('--samples <count>', `integer sample budget (${MIN_SAMPLES}–${MAX_SAMPLES})`, positiveInteger)
    .option('--language <code>', 'probe language: en or zh (defaults to bank)')
    .option('--temperature <number>', 'API sampling temperature (must match bank)', temperatureValue)
    .option('--timeout <ms>', 'overall probe timeout in milliseconds', positiveInteger, 120_000)
    .option('--tokenizer', 'first run the diagnostic tokenizer challenge (extra request; excluded from identification)')
    .option('--no-tokenizer', 'skip the diagnostic tokenizer challenge (default)')
    .option('--no-early-stop', 'collect the full requested integer budget')
    .option('--stream', 'display incoming model text on stderr', false)
    .option('--json', 'emit machine-readable JSON only on stdout', false)
    .option('--allow-insecure-http', 'allow HTTP for non-local endpoints', false)
    .option('--no-interactive', 'never open interactive prompts');

  program.command('bank-create')
    .description('Build an empirical bank from independently collected labeled runs')
    .requiredOption('--input <path>', 'enrollment JSON (training and held-out runs)')
    .requiredOption('--output <path>', 'new bank JSON path; existing files are never overwritten')
    .action(async (options: { input: string; output: string }) => {
      const data = await readBoundedText(options.input, MAX_PAYLOAD_BYTES, 'Enrollment input must be a JSON file no larger than 16 MiB');
      let input: unknown;
      // JSON.parse messages quote the input; report the failure without echoing file content.
      try { input = JSON.parse(data); } catch { throw new Error('Enrollment input is not valid JSON'); }
      const bank = createFingerprintBank(input as EnrollmentInput);
      await writeFile(options.output, `${JSON.stringify(bank, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      process.stdout.write('Fingerprint bank created. Early stopping remains disabled pending independent sequential validation.\n');
    });

  program.action(async (options: Options & { interactive: boolean }) => {
    if (options.key !== undefined && options.keyFile !== undefined) throw new Error('Use either --key or --key-file');
    if (!options.driver && !options.endpoint) {
      if (!process.stdin.isTTY || !process.stdout.isTTY || !options.interactive || options.json) {
        throw new Error('Choose --driver claude, --driver codex, or --endpoint <url> --model <id>');
      }
      await interactive(options);
    }
    if (options.driver && options.endpoint) throw new Error('Choose either --driver or --endpoint');
    if (options.driver && !['claude', 'codex'].includes(options.driver)) throw new Error('Driver must be claude or codex');
    if (!['openai', 'anthropic'].includes(options.provider)) throw new Error('Provider must be openai or anthropic');
    if (options.language && !['en', 'zh'].includes(options.language)) throw new Error('Language must be en or zh');
    if (options.apiFormat && !['chat-completions', 'responses'].includes(options.apiFormat)) throw new Error('API format must be chat-completions or responses');
    if (options.tokenLimitField && !['max_tokens', 'max_completion_tokens', 'max_output_tokens'].includes(options.tokenLimitField)) throw new Error('Invalid token limit field');
    if (options.driver && (options.key || options.keyFile !== undefined || options.temperature !== undefined || options.apiFormat || options.tokenLimitField || options.maxTokens !== undefined)) {
      throw new Error('Keys, temperature, API format, and token limits are API-only options');
    }
    if (options.samples !== undefined && (options.samples < MIN_SAMPLES || options.samples > MAX_SAMPLES)) {
      throw new Error(`--samples must be between ${MIN_SAMPLES} and ${MAX_SAMPLES}`);
    }
    let transport: ProbeTransport;
    if (options.driver) {
      const driverOptions = options.model ? { model: options.model } : {};
      transport = options.driver === 'claude' ? new ClaudeDriver(driverOptions) : new CodexDriver(driverOptions);
    } else {
      if (!options.model) throw new Error('--model is required for API mode');
      // Stored as the --key value so error redaction covers it.
      if (options.keyFile !== undefined) options.key = await readKeyFile(options.keyFile);
      const key = resolveApiKey(options);
      const note = key ? undefined : withheldKeyNote(options);
      if (note) process.stderr.write(`${pc.yellow('Note:')} ${note}\n`);
      transport = new HttpClient({
        provider: options.provider as Provider, baseURL: options.endpoint!, model: options.model,
        ...(options.apiFormat ? { apiFormat: options.apiFormat as ApiFormat } : {}),
        ...(options.tokenLimitField ? { tokenLimitField: options.tokenLimitField as TokenLimitField } : {}),
        allowInsecureHttp: options.allowInsecureHttp, ...(key ? { apiKey: key } : {}),
      });
    }
    const bank = options.bank ? await loadBank(options.bank) : undefined;
    const controller = new AbortController();
    // Persistent listeners, not once(): signal-exit, which execa's subprocess cleanup and ora load,
    // re-raises a signal when no other listener remains, ending the process before the probe
    // stops its CLI, removes the temporary directory, and reports the interruption.
    const abort = () => {
      // A second signal stops waiting for that cleanup.
      if (controller.signal.aborted) process.exit(130);
      controller.abort(new Error('Interrupted'));
    };
    process.on('SIGINT', abort);
    process.on('SIGTERM', abort);
    const spinner = ora({ text: 'Running fingerprint probes…', stream: process.stderr, isEnabled: !!process.stderr.isTTY && !options.json && !options.stream });
    spinner.start();
    try {
      const result = await fingerprint(transport, {
        ...(bank ? { bank } : {}), signal: controller.signal, timeoutMs: options.timeout,
        tokenizerProbe: options.tokenizer === true, earlyStopping: options.earlyStop,
        allowTransportMismatch: options.allowTransportMismatch,
        ...(options.samples !== undefined ? { samples: options.samples } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.language ? { language: options.language as Language } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        onText: (text) => { if (options.stream) process.stderr.write(safeText(text)); },
        onProgress: (samples) => { spinner.text = `Collected ${samples} integers…`; },
      });
      spinner.stop();
      if (options.stream) process.stderr.write('\n');
      if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else display(result);
      process.exitCode = result.status === 'IDENTIFIED' ? 0 : 2;
    } finally {
      spinner.stop();
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
  });
  try { await program.parseAsync(argv); }
  catch (error) {
    const parserError = error instanceof CommanderError;
    if (parserError) {
      // Help and version text already went to stdout.
      if (error.exitCode === 0) return;
      // Outside JSON mode, commander has already printed its message.
      if (!jsonRequested) { process.exitCode = error.exitCode; return; }
    }
    // Parsing can stop before --json is read; once parsing succeeded, the parsed flag decides.
    const json = parserError ? jsonRequested : program.opts<Options>().json;
    let message = error instanceof Error ? error.message : 'Unexpected failure';
    // Commander prefixes its messages for the terminal.
    if (parserError) message = message.replace(/^error: /, '');
    for (const secret of [program.opts<Options>().key, process.env.LOGITPING_API_KEY, process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY]) {
      if (secret) message = message.replaceAll(secret, '[redacted]');
    }
    if (json) process.stdout.write(`${JSON.stringify({ status: 'ERROR', ...errorDetails(error), error: safeText(message) })}\n`);
    else process.stderr.write(`${pc.red('Error:')} ${safeText(message)}\n`);
    process.exitCode = message === 'Interrupted' || message === 'Cancelled' ? 130 : 1;
  }
}
