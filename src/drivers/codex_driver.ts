import { LogitpingError } from '../core/errors.js';
import { asRecord } from '../util/validate.js';
import { CliDriver, type EventDecoder, type LaunchContext } from './base.js';

/**
 * Item kinds without side effects. Anything else (commands, file changes, MCP or web tools)
 * aborts the probe: a backend under test must not run tools on this machine, and tool use
 * would also contaminate the sample.
 */
const SAFE_ITEMS: ReadonlySet<unknown> = new Set(['agent_message', 'reasoning']);

/**
 * Codex features that let a backend act on this machine: run commands, read images, drive a
 * browser or desktop, call apps or plugins, spawn sub-agents, or trigger user hooks. Turning
 * them off narrows what the item check below must catch in time; it does not empty the tool
 * set. Set with `-c features.<name>=false`: `--disable` exits on names an installed version
 * does not know, while `-c` ignores them. codex-cli 0.160.0 keeps `unified_exec` enabled
 * despite either form, and MCP servers are not covered, so the item check stays the backstop.
 */
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'view_image', 'browser_use', 'browser_use_external', 'in_app_browser',
  'computer_use', 'apps', 'plugins', 'remote_plugin', 'multi_agent', 'hooks', 'skill_mcp_dependency_install',
] as const;

export class CodexEventDecoder implements EventDecoder {
  private complete = false;
  private readonly emitted = new Set<string>();

  decode(event: Record<string, unknown>): string[] {
    if (event.type === 'turn.failed' || event.type === 'error') throw new LogitpingError('CLI_FAILED', 'Codex reported an unsuccessful probe');
    if (event.type === 'turn.completed') this.complete = true;
    if (typeof event.type !== 'string' || !event.type.startsWith('item.')) return [];
    const item = asRecord(event.item);
    // Fail closed on item.started, before a tool result can reach the backend.
    if (!SAFE_ITEMS.has(item.type)) throw new LogitpingError('CLI_FAILED', 'Codex attempted a tool action during the probe; aborted');
    // Never sample reasoning, partial messages, or usage counters.
    if (event.type !== 'item.completed' || item.type !== 'agent_message' || typeof item.text !== 'string') return [];
    if (typeof item.id === 'string') {
      if (this.emitted.has(item.id)) return [];
      this.emitted.add(item.id);
    }
    return [item.text];
  }

  finish(): void {
    if (!this.complete) throw new LogitpingError('CLI_FAILED', 'Codex output ended before its turn completion event');
  }
}

/** Overrides shared by the probe and the MCP listing, so the listing describes the probe's configuration. */
const CONFIG_OVERRIDES = [
  '-c', 'approval_policy="never"',
  ...DISABLED_FEATURES.flatMap((feature) => ['-c', `features.${feature}=false`]),
];

/** MCP server names a dotted `-c mcp_servers.<name>` path can address: Codex splits it on dots, without quoting. */
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,128}$/;

export class CodexDriver extends CliDriver {
  readonly name = 'codex' as const;
  readonly granularity = 'message' as const;

  protected args(mcpOverrides: readonly string[] = []): string[] {
    return [
      'exec', '--json', '--color', 'never', '--sandbox', 'read-only',
      '--skip-git-repo-check', '--ephemeral', ...CONFIG_OVERRIDES, ...mcpOverrides,
      ...(this.options.model ? ['--model', this.options.model] : []),
      '-',
    ];
  }

  /**
   * MCP servers from the user's Codex configuration would stay available to the backend under test.
   * `-c` tables merge into that configuration, so `mcp_servers={}` removes nothing: each enabled
   * server is disabled by name. Fails closed when a server cannot be listed or addressed.
   */
  protected override async launchArgs(context: LaunchContext): Promise<string[]> {
    const output = await this.readOutput(context, ['mcp', 'list', '--json', ...CONFIG_OVERRIDES]);
    let servers: unknown;
    try { servers = JSON.parse(output); } catch { servers = undefined; }
    if (!Array.isArray(servers)) throw new LogitpingError('CLI_FAILED', 'Codex did not list its MCP servers as JSON; update Codex so the probe can disable them');
    // A server that does not report `enabled: false` is treated as enabled.
    const names = servers.map(asRecord).filter((server) => server.enabled !== false).map((server) => server.name);
    if (!names.every((name): name is string => typeof name === 'string' && MCP_SERVER_NAME.test(name))) {
      throw new LogitpingError('CLI_FAILED', 'A Codex MCP server name has characters other than letters, digits, - and _, so the probe cannot disable it; disable or rename that server in your Codex configuration');
    }
    return this.args(names.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]));
  }

  protected decoder(): EventDecoder { return new CodexEventDecoder(); }
}
