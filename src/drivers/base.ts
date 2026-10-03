import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { execa } from 'execa';
import { abortScope } from '../core/abort.js';
import { LogitpingError } from '../core/errors.js';
import type { ProbeRequest, ProbeTransport, StreamGranularity } from '../core/types.js';
import { asRecord, MAX_PAYLOAD_BYTES } from '../util/validate.js';

export interface DriverOptions {
  binary?: string;
  /** Passed as the CLI's --model value; must not look like a flag. */
  model?: string;
  /**
   * The CLI's complete environment. Defaults to this process's environment without
   * LOGITPING_API_KEY, which authenticates only API-mode probes.
   */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The API-mode probe key: a CLI never needs it, and a tool call racing the abort could read it. */
const WITHHELD_VARIABLE = 'LOGITPING_API_KEY';

/** This process's environment without the API-mode key; names compare case-insensitively, as on Windows. */
function inheritedEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== WITHHELD_VARIABLE));
}

/**
 * Starts with a letter or digit, so a CLI parser never reads it as a flag. Only model-identifier
 * punctuation follows: on Windows an npm-installed CLI is a .cmd shim whose arguments cmd.exe
 * parses again, where a quote followed by & | < or > would run a command.
 */
const CLI_MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/@[\]-]{0,255}$/;

const cliError = (message: string) => new LogitpingError('CLI_FAILED', message);
const notFound = (name: string) => new LogitpingError('CLI_NOT_FOUND', `${name} was not found on PATH; install and log in to that CLI first`);

export interface EventDecoder {
  decode(event: Record<string, unknown>): string[];
  finish(): void;
}

/** The executable, environment, and directory of one probe launch, for commands that prepare it. */
export interface LaunchContext {
  binary: string;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
}

export abstract class CliDriver implements ProbeTransport {
  /** Also the default executable name. */
  abstract readonly name: string;
  abstract readonly granularity: StreamGranularity;
  constructor(protected readonly options: DriverOptions = {}) {
    if (options.model !== undefined && (typeof options.model !== 'string' || !CLI_MODEL.test(options.model))) {
      throw new TypeError('CLI model must start with a letter or digit and contain only letters, digits, and . _ : / @ [ ] -');
    }
  }
  protected abstract args(): string[];
  protected abstract decoder(): EventDecoder;

  /** Arguments for one launch; override to adapt them to the installed CLI's configuration. */
  protected async launchArgs(_context: LaunchContext): Promise<string[]> {
    return this.args();
  }

  /** Run a short command of this CLI in the probe's environment and directory, and return its stdout. */
  protected async readOutput(context: LaunchContext, args: string[]): Promise<string> {
    try {
      const { stdout } = await execa(context.binary, args, {
        cwd: context.cwd,
        env: context.env,
        extendEnv: false,
        shell: false,
        stdin: 'ignore',
        stderr: 'ignore',
        maxBuffer: 1_048_576,
        signal: context.signal,
        cleanup: true,
        windowsHide: true,
      });
      return stdout;
    } catch (error) {
      context.signal.throwIfAborted();
      if (asRecord(error).code === 'ENOENT') throw notFound(this.name);
      throw cliError(`${this.name} ${args.slice(0, 2).join(' ')} failed; check that the installed version supports it (run ${this.name} --help)`);
    }
  }

  async *stream(request: ProbeRequest): AsyncGenerator<string> {
    const scope = abortScope(request.signal, request.timeoutMs);
    let directory: string | undefined;
    try {
      scope.signal.throwIfAborted();
      directory = await mkdtemp(join(tmpdir(), 'logitping-'));
      scope.signal.throwIfAborted();
      const binary = this.options.binary ?? this.name;
      // The complete environment; execa must not merge process.env back in.
      const env = this.options.env ?? inheritedEnvironment();
      const args = await this.launchArgs({ binary, cwd: directory, env, signal: scope.signal });
      scope.signal.throwIfAborted();
      const child = execa(binary, args, {
        cwd: directory,
        input: request.prompt,
        env,
        extendEnv: false,
        shell: false,
        buffer: false,
        stderr: 'ignore',
        cleanup: true,
        windowsHide: true,
      });
      // Attach a rejection handler immediately, before consuming streaming output.
      const outcome = child.then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
      const stop = () => { child.kill('SIGTERM', { forceKillAfterTimeout: 1_000 }); };
      scope.signal.addEventListener('abort', stop, { once: true });
      if (scope.signal.aborted) stop();
      try {
        const decoder = this.decoder();
        const utf8 = new StringDecoder('utf8');
        let pending = '';
        let bytes = 0;
        const decodeLine = (line: string) => {
          if (!line.trim()) return [];
          if (line.length > 1_048_576) throw cliError('CLI event exceeded 1 MiB');
          let event: unknown;
          try { event = JSON.parse(line); } catch { throw cliError(`${this.name} emitted malformed JSONL`); }
          return decoder.decode(asRecord(event));
        };
        if (child.stdout) {
          for await (const chunk of child.stdout) {
            scope.signal.throwIfAborted();
            const buffer = chunk as Buffer;
            bytes += buffer.length;
            if (bytes > MAX_PAYLOAD_BYTES) throw cliError('CLI output exceeded 16 MiB');
            pending += utf8.write(buffer);
            let newline: number;
            while ((newline = pending.indexOf('\n')) >= 0) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              for (const text of decodeLine(line)) {
                scope.signal.throwIfAborted();
                yield text;
              }
            }
            if (pending.length > 1_048_576) throw cliError('CLI event exceeded 1 MiB');
          }
        }
        scope.signal.throwIfAborted();
        const { error } = await outcome;
        if (error) {
          if (asRecord(error).code === 'ENOENT') throw notFound(this.name);
          throw cliError(`${this.name} probe failed; check the CLI login and supported flags (run ${this.name} --help)`);
        }
        pending += utf8.end();
        for (const text of decodeLine(pending)) yield text;
        decoder.finish();
      } finally {
        scope.signal.removeEventListener('abort', stop);
        stop();
        await outcome;
      }
    } finally {
      scope.dispose();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
