import { LogitpingError } from '../core/errors.js';
import { asRecord } from '../util/validate.js';
import { CliDriver, type EventDecoder } from './base.js';

/**
 * Steps without side effects. agy has no flag that turns tools off, and in headless mode it runs
 * read-only tools such as view_file without a permission prompt, so any other step (a tool, a
 * subagent, a browser action) aborts the probe when it is reported ACTIVE, before its result can
 * reach the backend.
 */
const SAFE_STEPS: ReadonlySet<unknown> = new Set(['user_input', 'agent_response', 'error_message']);

/** The headless permission mode that denies every tool needing a prompt instead of running it. */
const REVIEWED = 'request-review';

/** gRPC status names, which agy puts before the HTTP code of a backend error: fixed identifiers, safe to report. */
const STATUSES: ReadonlySet<string> = new Set([
  'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS',
  'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE',
  'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED',
]);

const toolAction = () => new LogitpingError('CLI_FAILED', 'Antigravity attempted a tool action during the probe; aborted');

/** Names the status and code of agy's error, never its free text. */
function unsuccessful(error?: unknown): LogitpingError {
  let message = 'Antigravity reported an unsuccessful probe';
  const text = typeof error === 'string' ? error : '';
  const [, status, code] = /^([A-Z_]+) \(code (\d{3})\)/.exec(text) ?? [];
  if (status && STATUSES.has(status)) {
    message += `: ${status} (code ${code})`;
    if (/location is not supported/i.test(text)) message += '; the backend does not serve requests from this location';
  }
  return new LogitpingError('CLI_FAILED', message);
}

export class AntigravityEventDecoder implements EventDecoder {
  private conversation: unknown;
  private started = false;
  private complete = false;
  private emitted = false;
  private failed = false;

  decode(event: Record<string, unknown>): string[] {
    if (event.event === 'result') {
      const result = asRecord(event.result);
      // Also reported without an init event, for example for an empty prompt.
      if (this.failed || result.status !== 'SUCCESS') throw unsuccessful(result.error);
      if (Array.isArray(result.denied_actions) && result.denied_actions.length) throw toolAction();
      this.complete = true;
      return !this.emitted && typeof result.response === 'string' && result.response ? [result.response] : [];
    }
    if (event.event === 'init') {
      if (asRecord(event.init).permission_mode !== REVIEWED) {
        throw new LogitpingError('CLI_FAILED', `Antigravity did not start in ${REVIEWED} permission mode, so tools could run without review; aborted`);
      }
      this.started = true;
      this.conversation = event.conversation_id;
      return [];
    }
    if (event.event !== 'step_update') return [];
    // The permission mode is checked first: nothing is sampled without it.
    if (!this.started) throw new LogitpingError('CLI_FAILED', 'Antigravity output did not start with its init event');
    const step = asRecord(event.step_update);
    if (!SAFE_STEPS.has(step.step_type)) throw toolAction();
    if (step.state === 'ERROR') throw unsuccessful();
    // agy ends a turn its backend refused with this step; the result event that follows has the cause.
    if (step.step_type === 'error_message') this.failed = true;
    // Never sample reasoning, usage counters, or another conversation's steps.
    if (step.step_type !== 'agent_response' || step.conversation_id !== this.conversation || typeof step.text_delta !== 'string') return [];
    this.emitted = true;
    return [step.text_delta];
  }

  finish(): void {
    if (!this.complete) throw new LogitpingError('CLI_FAILED', 'Antigravity output ended before its result event');
  }
}

export class AntigravityDriver extends CliDriver {
  readonly name = 'antigravity' as const;
  readonly granularity = 'token' as const;

  protected override executable(): string { return 'agy'; }

  /**
   * `-p` reads the prompt only from its argument; stream-json input reads it from stdin, where
   * every driver sends it. `--mode plan` is omitted: agy ignores it while slash commands are disabled.
   */
  protected args(): string[] {
    return [
      '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--sandbox', '--disable-slash-commands',
      ...(this.options.model ? ['--model', this.options.model] : []),
    ];
  }

  /** One user message; agy runs a turn for each line and exits when stdin closes. */
  protected override stdin(prompt: string): string {
    return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
  }

  protected decoder(): EventDecoder { return new AntigravityEventDecoder(); }
}
