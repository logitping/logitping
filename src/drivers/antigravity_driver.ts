import { LogitpingError } from '../core/errors.js';
import { asRecord } from '../util/validate.js';
import { CliDriver, type EventDecoder } from './base.js';

/**
 * Steps without side effects. agy has no flag that turns tools off, and in headless mode it runs
 * read-only tools such as view_file without a permission prompt, so any other step (a tool, a
 * subagent, a browser action) aborts the probe when it is reported ACTIVE, before its result can
 * reach the backend.
 */
const SAFE_STEPS: ReadonlySet<unknown> = new Set(['user_input', 'agent_response']);

/** The headless permission mode that denies every tool needing a prompt instead of running it. */
const REVIEWED = 'request-review';

const toolAction = () => new LogitpingError('CLI_FAILED', 'Antigravity attempted a tool action during the probe; aborted');
const unsuccessful = () => new LogitpingError('CLI_FAILED', 'Antigravity reported an unsuccessful probe');

export class AntigravityEventDecoder implements EventDecoder {
  private conversation: unknown;
  private started = false;
  private complete = false;
  private emitted = false;

  decode(event: Record<string, unknown>): string[] {
    if (event.event === 'result') {
      const result = asRecord(event.result);
      // Also reported without an init event, for example for an empty prompt.
      if (result.status !== 'SUCCESS') throw unsuccessful();
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
