import { LogitpingError } from '../core/errors.js';
import { asRecord } from '../util/validate.js';
import { CliDriver, type EventDecoder } from './base.js';

/** Content blocks that mean a tool was requested or already ran. */
const TOOL_BLOCKS: ReadonlySet<unknown> = new Set(['tool_use', 'server_tool_use', 'tool_result']);

/**
 * `--tools ''` disables tools; this fails closed in case a CLI version ignores that flag.
 * Checked before the nested-agent filter: a nested agent exists only if a tool already ran.
 */
function requestsTool(event: Record<string, unknown>): boolean {
  if (TOOL_BLOCKS.has(asRecord(asRecord(event.event).content_block).type)) return true;
  const content = asRecord(event.message).content;
  return Array.isArray(content) && content.some((block: unknown) => TOOL_BLOCKS.has(asRecord(block).type));
}

export class ClaudeEventDecoder implements EventDecoder {
  private partial = false;
  private complete = false;
  private messageEmitted = false;

  decode(event: Record<string, unknown>): string[] {
    if (requestsTool(event)) throw new LogitpingError('CLI_FAILED', 'Claude attempted a tool action during the probe; aborted');
    if (event.parent_tool_use_id) return [];
    if (event.type === 'result') {
      if (event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success')) {
        throw new LogitpingError('CLI_FAILED', 'Claude reported an unsuccessful probe');
      }
      this.complete = true;
      if (!this.partial && !this.messageEmitted && typeof event.result === 'string') return [event.result];
    }
    if (event.type === 'stream_event') {
      const payload = asRecord(event.event);
      if (payload.type === 'message_start') this.partial = false;
      const delta = asRecord(payload.delta);
      if (payload.type === 'content_block_delta' && delta.type === 'text_delta' && typeof delta.text === 'string') {
        this.partial = true;
        this.messageEmitted = true;
        return [delta.text];
      }
    }
    if (event.type === 'assistant' && !this.partial) {
      const content = asRecord(event.message).content;
      if (Array.isArray(content)) {
        const text = content.map(asRecord).filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text as string);
        this.messageEmitted ||= text.length > 0;
        return text;
      }
    }
    return [];
  }

  finish(): void {
    if (!this.complete) throw new LogitpingError('CLI_FAILED', 'Claude output ended before its result event');
  }
}

export class ClaudeDriver extends CliDriver {
  readonly name = 'claude' as const;
  readonly granularity = 'token' as const;

  protected args(): string[] {
    return [
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--tools', '', '--permission-mode', 'dontAsk', '--disable-slash-commands',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--settings', '{"disableAllHooks":true}', '--no-session-persistence',
      ...(this.options.model ? ['--model', this.options.model] : []),
    ];
  }

  protected decoder(): EventDecoder { return new ClaudeEventDecoder(); }
}
