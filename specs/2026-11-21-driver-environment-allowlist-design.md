# CLI driver environment allowlist: design

Status: drafted on 2026-11-21 as item 2 of the 0.8.0 plan, for review.

## Context

`CliDriver` starts Claude, Codex and `agy` with this process's whole environment, minus `LOGITPING_API_KEY` (`src/drivers/base.ts`, `inheritedEnvironment`). Codex and Antigravity can start a tool before the driver sees the event and terminates the CLI. Such a tool can read every variable the CLI received: another vendor's API key, cloud credentials, CI tokens, `SSH_AUTH_SOCK`. The tool is triggered by the backend under test, which is exactly the party a fingerprinting probe does not trust.

An allowlist narrows that exposure. It is defense in depth, not an isolation boundary:
- a tool that starts in time can still read any file the user's account can read, such as `~/.aws/credentials`;
- it can also read the CLI's own credentials, which that CLI's backend already receives with each request.

The docs must say both.

**Evidence for the allowlist.** On 2026-11-21, the variable names were read from the installed binaries' strings, offline (Claude Code 2.1.329, codex-cli 0.171.0, `agy` 1.5.13):
- **Claude Code:** reads `CLAUDE_*` and `ANTHROPIC_*`; cloud variables for Bedrock, Vertex and Azure (`AWS_*`, `GOOGLE_*`, `CLOUD_ML_REGION`, `AZURE_*`); and a small common core.
- **Codex:** reads `CODEX_*` and `OPENAI_API_KEY`, plus the same core.
- **`agy`:** reads `AGY_*`, `ANTIGRAVITY_*`, `GEMINI_API_KEY`, and `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_GEMINI_BASE_URL`, plus the core.

The common core is `HOME`, `PATH`, `USER`/`LOGNAME`, `SHELL`, `TERM`, `TMPDIR`, `LANG`/`LC_*`, `XDG_*`, proxy and certificate variables, and on Windows the system and profile variables.

## Decisions

| Topic | Decision |
| --- | --- |
| Default environment | Only the shared variables below, plus the driver's vendor prefixes. Names match case-insensitively, as on Windows; a prefix matches any name that starts with it. Variables with no value are dropped. |
| Never passed | `LOGITPING_API_KEY`, in any letter case, whatever pattern would match it. Only an explicit `env` can carry it, as today. |
| Vendor prefixes | Claude: `CLAUDE_`, `ANTHROPIC_`, and the exact opt-out names `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`. Codex: `CODEX_`, `OPENAI_`. Antigravity: `AGY_`, `ANTIGRAVITY_`, `GEMINI_`, `GOOGLE_`. A `CliDriver` subclass that overrides nothing gets the shared variables only. |
| Escape hatch, library | `DriverOptions.passEnv?: readonly string[]` adds names, or prefixes written `NAME_*` with at least one character before `*`, read from this process's environment. `env` keeps its meaning (the CLI's complete environment). Giving both is a `TypeError`. |
| Escape hatch, CLI | `--pass-env <name>`, repeatable, only with `--driver`; it maps to `passEnv`. With an API endpoint it is a usage error before any request. |
| Validation | Each `passEnv` entry must match `/^[A-Za-z_][A-Za-z0-9_]*\*?$/` and must not be bare `*`; `LOGITPING_API_KEY` itself is refused. Checked in the `CliDriver` constructor, so a bad value fails before any process starts. |
| Code location | `src/drivers/environment.ts` (pure). `CliDriver` gains `protected environmentPrefixes(): readonly string[]` (default `[]`) and `protected environment()`, which `stream()` and Codex's `mcp list` both use. Public API: the new `passEnv` option, plus the protected hooks `environmentPrefixes()` and `environment()` for subclasses. |
| Compatibility | A breaking change for setups that need other variables, such as Claude Code through Bedrock (`AWS_*`) or Vertex (`GOOGLE_*`, `CLOUD_ML_REGION`); `--pass-env` restores them. The changelog says so. |

**Shared variables** (exact names):

- **Process and locale:** `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `TZ`.
- **XDG and session:** `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`.
- **Network and TLS:** `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_SYSTEM_CA`.
- **Windows:** `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `PATHEXT`, `SYSTEMDRIVE`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `USERNAME`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, `PROGRAMFILES`, `PROGRAMFILES(X86)`, `PROCESSOR_ARCHITECTURE`.
- **Opt-out:** `DO_NOT_TRACK`.

**Deliberately excluded** from the shared variables:
- `SSH_AUTH_SOCK`, because it grants use of the SSH agent;
- `GIT_*` and `GH_*`;
- `NODE_OPTIONS`, which can load code into a Node-based CLI;
- CI and terminal markers;
- `CLAUDECODE`, the marker a parent Claude Code session sets, which no prefix matches.

## Documentation changes

Fixed copy, replacing the named sentences.

**`docs/transports.md`: in the bullet that begins "Subprocesses receive the prompt on stdin", replace "A CLI inherits your environment except `LOGITPING_API_KEY`, which only API probes use." with:**

> A CLI receives only part of your environment: common system, locale, temporary-directory, proxy and certificate variables, the `DO_NOT_TRACK` opt-out, and its own vendor's variables (`CLAUDE_*` and `ANTHROPIC_*`, plus the `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` and `DISABLE_AUTOUPDATER` opt-outs, for Claude; `CODEX_*` and `OPENAI_*` for Codex; `AGY_*`, `ANTIGRAVITY_*`, `GEMINI_*` and `GOOGLE_*` for Antigravity, which includes any Google Cloud credentials kept in `GOOGLE_*` variables). Other variables, such as another vendor's API key, AWS or Azure credentials, or `SSH_AUTH_SOCK`, are not passed. `--pass-env <name>` (library: `passEnv`) adds a variable, or a prefix such as `AWS_*` for Claude Code through Amazon Bedrock. `LOGITPING_API_KEY` is never passed. This stops the CLI from being handed those variables; it does not hide them from a tool that starts before the probe stops it. Such a tool can still read the CLI's own credentials and any file your account can read, and on Linux usually the environment of your other processes, including lping's own (`/proc/<pid>/environ`). Keep secrets you do not want exposed out of the environment you start `lping` from.

**`SECURITY.md`: in the "Developer CLIs retain local access" bullet, replace "They inherit the environment except for `LOGITPING_API_KEY`; other secrets present in the environment may still be available to the child process." with:**

> They receive only an allowlist of the environment: system, locale, proxy and certificate variables, the CLI's own vendor variables, and any named with `--pass-env`. `LOGITPING_API_KEY` is never passed to the CLI. A tool that starts before the probe stops it can still read the CLI's own credentials, any file your account can read, and on Linux usually the environment of your other processes, including lping's own (`/proc/<pid>/environ`); keep secrets you do not want exposed out of the environment you start `lping` from.

**`docs/library.md`: replace "Their `env` option sets the CLI's complete environment; by default the CLI inherits yours without `LOGITPING_API_KEY`." with:**

> Their `env` option sets the CLI's complete environment. By default the CLI receives an allowlist of yours, described in the [transport limitations](transports.md), and never `LOGITPING_API_KEY`; `passEnv` adds variable names or prefixes such as `'AWS_*'`, and cannot be combined with `env`. A `CliDriver` subclass receives only the shared variables unless it overrides the protected `environmentPrefixes()` with its CLI's prefixes or is given `passEnv`.

**`docs/cli.md`: after the line `lping --driver antigravity --model gemini-3.8-flash-low   # runs agy; ...`, add:**

> `lping --driver claude --pass-env 'AWS_*'   # a CLI gets only part of your environment; pass what its login needs, such as Bedrock's AWS credentials`

**`README.md`: after "Local CLI probes reuse your login and may incur provider usage or charges.", add:**

> They receive only part of your environment; add what a login needs with `--pass-env`, such as `--pass-env 'AWS_*'` for Claude Code through Amazon Bedrock.

**`CHANGELOG.md`: under `## Unreleased`, between `### Added` and `### Documentation`, add:**

> ### Changed
>
> - **CLI drivers no longer inherit your whole environment.** Claude, Codex and `agy` receive common system, locale, proxy and certificate variables, `DO_NOT_TRACK`, and their own vendor's variables (`CLAUDE_*`/`ANTHROPIC_*` with Claude Code's `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` and `DISABLE_AUTOUPDATER` opt-outs, `CODEX_*`/`OPENAI_*`, `AGY_*`/`ANTIGRAVITY_*`/`GEMINI_*`/`GOOGLE_*`), so the CLI is no longer handed other vendors' keys or AWS and Azure credentials. This narrows, but does not close, what a tool that starts before the probe stops it can read: it can still read files your account can read, and on Linux usually the environment of your other processes, including lping's own. A login that needs other variables, such as Claude Code through Amazon Bedrock, needs `--pass-env 'AWS_*'` (library: `passEnv`). `LOGITPING_API_KEY` is still never passed.
> - **Breaking for custom drivers:** a `CliDriver` subclass now receives only the shared variables unless it overrides `environmentPrefixes()` or is given `passEnv`.

## Erratum (2026-11-21, final review)

- The documentation copy above originally said a tool racing the probe "cannot read other vendors' keys or cloud credentials from the environment". On Linux, a same-user process can usually read other processes' environments from `/proc/<pid>/environ`, including lping's own, so the copy now says the CLI is no longer handed those variables, and names that limit.
- Shell-exported opt-outs were dropped, so probes could send telemetry or error reports a user had turned off. `DO_NOT_TRACK` joined the shared variables, and Claude's prefixes gained Claude Code's unprefixed `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` and `DISABLE_AUTOUPDATER`, found in the 2.1.329 binary.
- The copy now states that `GOOGLE_*` passes Google Cloud credentials to Antigravity, and that a plain `CliDriver` subclass receives only the shared variables.

## Out of scope

- An OS-level sandbox for the CLI drivers.
- Changing the API transport.
- Live probes of the real CLIs in tests. A manual check with the real binaries needs the user's approval, because each probe is a provider request.
