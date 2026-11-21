# CLI Driver Environment Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude, Codex and `agy` receive only an allowlist of the environment: shared system, locale, proxy and certificate variables plus their own vendor's prefixes. Users can add more with `passEnv` / `--pass-env`, and `LOGITPING_API_KEY` is never passed.

**Architecture:** A pure module, `src/drivers/environment.ts`, decides which variables pass. `CliDriver` validates `passEnv` in its constructor and computes the environment once per launch through `environment()`. That environment reaches both the probe and Codex's `mcp list`. Each driver declares its vendor prefixes through `environmentPrefixes()`. The CLI maps a repeatable `--pass-env` flag onto `passEnv`.

**Tech Stack:** TypeScript ESM on Node ≥ 22, vitest, execa. No new dependencies.

**Spec:** `specs/2026-11-21-driver-environment-allowlist-design.md`

**Branch:** `feat/driver-env-allowlist`, created from local `main` at `606b2ae`.

## Global Constraints

- The shared variable list, vendor prefixes, validation pattern and error messages are exactly as the spec and the tasks below state them.
- `env` keeps its meaning: it is the CLI's complete environment and may deliberately include `LOGITPING_API_KEY`. Without `env`, `LOGITPING_API_KEY` never reaches a CLI, in any letter case.
- Public API change: only the new optional `DriverOptions.passEnv`. Do not make `CliDriver` methods abstract, because user subclasses must keep compiling.
- No provider requests and no real CLI launches in tests.
- The repository is public under a pseudonymous identity. Commits, specs and docs must not contain absolute paths, the local username or scratchpad paths.
- In the maintainer's shell, `npm` may be the Socket wrapper. Verify with `./node_modules/.bin/tsc --noEmit` and `./node_modules/.bin/vitest run`, build with `npm run build`, and run scripts with `node`.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Windows-style names, mixed case and `ProgramFiles(x86)`, must pass, because Windows names are case-insensitive (Task 1 test `keeps shared variables in any letter case`).
2. Another vendor's API key and cloud credentials must not reach a driver even when they are set (Task 1 test `keeps the driver's prefixes and drops everything else`; Task 2 test `gives each driver its own vendor variables`).
3. `LOGITPING_API_KEY` must not slip through a prefix or a `passEnv` pattern that happens to match it (Task 1 test `never passes LOGITPING_API_KEY`).
4. A CLI that relies on a custom variable must keep working through `--pass-env`. The packaging smoke test's fake `claude` is such a CLI (Task 3 steps 4–6).
5. `--pass-env` with an API endpoint must fail before any request (Task 3 test `rejects ... before any request`).

---

### Task 1: Environment allowlist module

**Files:**
- Create: `src/drivers/environment.ts`
- Test: `tests/driver-environment.test.ts`

**Interfaces:**
- Produces:
  - `const WITHHELD_VARIABLE = 'LOGITPING_API_KEY'`
  - `const SHARED_VARIABLES: readonly string[]`, the spec's 44 names, in its order.
  - `checkPassEnv(patterns: unknown): asserts patterns is readonly string[]`. It throws `TypeError`:
    - `passEnv entries must be variable names or prefixes ending in *, such as AWS_*` for a non-array, a non-string, an entry not matching `/^[A-Za-z_][A-Za-z0-9_]*\*?$/`, or a bare `*`;
    - `LOGITPING_API_KEY is never passed to a CLI; supply a complete environment with env to pass it deliberately` for that name in any letter case.
  - `driverEnvironment(source: Readonly<Record<string, string | undefined>>, prefixes: readonly string[], passEnv: readonly string[] = []): Record<string, string>`.

- [ ] **Step 1: Write the failing tests** in `tests/driver-environment.test.ts` (`describe('driver environment')`):

- `keeps shared variables in any letter case`:
  - input: `{ PATH: '/usr/bin', HOME: '/home/u', http_proxy: 'http://proxy:8080', SystemRoot: 'C:\\Windows', 'ProgramFiles(x86)': 'C:\\PF86' }`, prefixes `[]`;
  - output: that object, unchanged.
- `keeps the driver's prefixes and drops everything else`:
  - input: `{ PATH: '/bin', CODEX_HOME: '/c', OPENAI_API_KEY: 'sk-o', ANTHROPIC_API_KEY: 'sk-a', AWS_SECRET_ACCESS_KEY: 'aws', GITHUB_TOKEN: 'gh', SSH_AUTH_SOCK: '/tmp/agent', NODE_OPTIONS: '--require x', CLAUDECODE: '1' }`, prefixes `['CODEX_', 'OPENAI_']`;
  - output: `{ PATH: '/bin', CODEX_HOME: '/c', OPENAI_API_KEY: 'sk-o' }`.
- `never passes LOGITPING_API_KEY`:
  - input: `{ LOGITPING_API_KEY: 'k', logitping_api_key: 'k', LOGITPING_TEST: 'x' }`, prefixes `['LOGITPING_']`, passEnv `['LOGITPING_*']`;
  - output: `{ LOGITPING_TEST: 'x' }`.
- `adds passEnv names and prefixes, case-insensitively`:
  - input: `{ AWS_REGION: 'us-east-1', aws_profile: 'dev', CLOUD_ML_REGION: 'us-east5', OTHER: 'no' }`, prefixes `[]`, passEnv `['aws_*', 'cloud_ml_region']`;
  - output: `{ AWS_REGION: 'us-east-1', aws_profile: 'dev', CLOUD_ML_REGION: 'us-east5' }`.
- `drops variables without a value, keeping empty strings`: `{ PATH: undefined, HOME: '/h', NO_PROXY: '' }` gives `{ HOME: '/h', NO_PROXY: '' }`.
- `accepts names and prefixes`: `checkPassEnv(['AWS_*', 'FOO', '_X'])` does not throw.
- `rejects malformed passEnv entries`: each of `['*']`, `['AWS*X']`, `['bad-name']`, `['']`, `[7]` and `'AWS_*'` throws `TypeError` matching `/variable names or prefixes ending in \*/`.
- `refuses to pass the API-mode key`: `checkPassEnv(['logitping_api_key'])` throws `/never passed to a CLI/`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/driver-environment.test.ts`
Expected: FAIL, the module cannot be found.

- [ ] **Step 3: Implement `src/drivers/environment.ts`**

- Compare names by `toUpperCase()`.
- A variable passes when its uppercased name:
  - is in `SHARED_VARIABLES`;
  - or starts with an uppercased prefix;
  - or equals an uppercased `passEnv` name;
  - or starts with the part before `*` of an uppercased `passEnv` prefix.
- It never passes when its uppercased name equals `WITHHELD_VARIABLE`.
- Keep `string` values, including `''`. Skip `undefined`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run tests/driver-environment.test.ts && ./node_modules/.bin/tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/drivers/environment.ts tests/driver-environment.test.ts specs/2026-11-21-driver-environment-allowlist-design.md specs/2026-11-21-driver-environment-allowlist-plan.md
git commit -m "feat: decide which environment variables a CLI driver may receive" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Drivers use the allowlist

**Files:**
- Modify: `src/drivers/base.ts` (remove `inheritedEnvironment` and its `WITHHELD_VARIABLE`; add `passEnv`, `environmentPrefixes()`, `environment()`), `src/drivers/claude_driver.ts`, `src/drivers/codex_driver.ts`, `src/drivers/antigravity_driver.ts`
- Test: `tests/drivers.test.ts`

**Interfaces:**
- Consumes: Task 1's `checkPassEnv` and `driverEnvironment`.
- Produces:
  - `DriverOptions.passEnv?: readonly string[]`, documented as names or `NAME_*` prefixes, read from this process's environment, never combined with `env`.
  - `CliDriver`'s constructor throws `TypeError('env is the complete environment; use passEnv only without it')` when both are given, and otherwise calls `checkPassEnv` on `passEnv` when present.
  - `protected environmentPrefixes(): readonly string[]` returns `[]`. Overrides: `ClaudeDriver` `['CLAUDE_', 'ANTHROPIC_']`, `CodexDriver` `['CODEX_', 'OPENAI_']`, `AntigravityDriver` `['AGY_', 'ANTIGRAVITY_', 'GEMINI_', 'GOOGLE_']`.
  - `protected environment(): Readonly<Record<string, string | undefined>>` returns `this.options.env ?? driverEnvironment(process.env, this.environmentPrefixes(), this.options.passEnv)`. `stream()` calls it once per launch, in place of `inheritedEnvironment()`, and passes the result to `launchArgs` as today.

- [ ] **Step 1: Update and add the failing tests** in `tests/drivers.test.ts`

In the fake script's `env` mode, also report `lang: process.env.LANG ?? null` next to `key`, `lower` and `marker`. Then:

- Rename `withholds the API-mode key, in any letter case, and keeps the rest of the environment` to `passes only allowlisted variables to the CLI process, never the API-mode key`. Stub `LOGITPING_API_KEY` and `logitping_api_key` (`'api-mode-secret'`), `LOGITPING_TEST_MARKER` (`'inherited'`) and `LANG` (`'C.logitping-test'`). Expect `{ key: null, lower: null, marker: null, lang: 'C.logitping-test' }`.
- New `passes variables named in passEnv`: with `LOGITPING_TEST_MARKER` and `LOGITPING_API_KEY` stubbed, `new FakeDriver('env', { passEnv: ['LOGITPING_TEST_*'] })` replies `{ key: null, lower: null, marker: 'inherited', lang: <process.env.LANG ?? null> }`.
- `gives the CLI exactly the environment a caller supplies`: its expected object gains `lang: null`.
- New `gives each driver its own vendor variables`:
  - Stub `ANTHROPIC_API_KEY='a'`, `CLAUDE_CONFIG_DIR='/cc'`, `OPENAI_API_KEY='o'`, `CODEX_HOME='/ch'`, `GEMINI_API_KEY='g'`, `GOOGLE_CLOUD_PROJECT='p'`, `AGY_X='1'`, `ANTIGRAVITY_Y='2'`, `AWS_SECRET_ACCESS_KEY='s'`.
  - Read each driver's `environment()` through a subclass exposing it, and pick only those nine names:
    - Claude: `{ ANTHROPIC_API_KEY: 'a', CLAUDE_CONFIG_DIR: '/cc' }`;
    - Codex: `{ OPENAI_API_KEY: 'o', CODEX_HOME: '/ch' }`;
    - Antigravity: `{ GEMINI_API_KEY: 'g', GOOGLE_CLOUD_PROJECT: 'p', AGY_X: '1', ANTIGRAVITY_Y: '2' }`;
    - `FakeDriver`: `{}`.
- New `rejects passEnv with env, and invalid passEnv, before starting a process`:
  - `new ClaudeDriver({ env: {}, passEnv: ['AWS_*'] })` throws `TypeError` with `/env is the complete environment/`;
  - `new CodexDriver({ passEnv: ['*'] })` throws `/prefixes ending in \*/`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/drivers.test.ts`
Expected: FAIL. The renamed test still sees `marker: 'inherited'`, `passEnv` is ignored, `environment` does not exist, and the constructor accepts both options.

- [ ] **Step 3: Implement** the interfaces above in `base.ts` and the three drivers.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run tests/drivers.test.ts tests/driver-environment.test.ts && ./node_modules/.bin/tsc --noEmit`
Expected: PASS. The existing Codex and Antigravity subprocess tests pass explicit `env` objects and are unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/drivers/base.ts src/drivers/claude_driver.ts src/drivers/codex_driver.ts src/drivers/antigravity_driver.ts tests/drivers.test.ts
git commit -m "feat: give CLI drivers only an allowlist of the environment" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: `--pass-env` and the packaging smoke test

**Files:**
- Modify: `src/cli.ts` (option, validation, driver options), `scripts/package-smoke.mjs` (interrupt test)
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `DriverOptions.passEnv` from Task 2.
- Produces:
  - `--pass-env <name>`, repeatable, collected in order into `options.passEnv: string[]`, default `[]`. Help text: `pass an environment variable, or a prefix such as AWS_*, to the --driver CLI; repeatable`.
  - With entries but no driver (after any interactive selection), it throws `Error('--pass-env applies only to --driver probes')` before any request.
  - The driver is constructed with `{ ...(model ? { model } : {}), ...(passEnv.length ? { passEnv } : {}) }`, so existing expectations such as `[{ model: 'gemini-3.8-flash-low' }]` and `[{}]` still hold.

- [ ] **Step 1: Write the failing tests** in `tests/cli.test.ts`

- New `passes --pass-env names to the driver in order`:
  - `main(['node', 'lping', '--driver', 'antigravity', '--pass-env', 'AWS_*', '--pass-env', 'CLOUD_ML_REGION', '--no-tokenizer', '--json'])`;
  - then `fake.antigravity` equals `[{ passEnv: ['AWS_*', 'CLOUD_ML_REGION'] }]` and `process.exitCode` is `2`.
- Add a row to the `rejects %j before any request` table: `[['--endpoint', 'https://proxy.example', '--model', 'm', '--pass-env', 'AWS_*'], '--pass-env applies only to --driver probes']`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/cli.test.ts`
Expected: FAIL, because commander rejects the unknown option `--pass-env`.

- [ ] **Step 3: Implement the option in `src/cli.ts`**

Place the `--pass-env` check next to the existing `API-only options` check, after the interactive selection.

- [ ] **Step 4: Run the CLI tests, then show that the smoke test breaks without the flag**

Run: `./node_modules/.bin/vitest run tests/cli.test.ts && npm run build && node scripts/package-smoke.mjs`
Expected: the vitest run PASSES. `package-smoke.mjs` FAILS at the interrupt check: its fake `claude` writes to `$LOGITPING_SMOKE_STARTED`, which the allowlist no longer passes, so the probe ends with an error instead of being interrupted.

- [ ] **Step 5: Pass the variable explicitly in `scripts/package-smoke.mjs`**

Add `'--pass-env', 'LOGITPING_SMOKE_STARTED'` to the `lping --driver claude --json` arguments of the interrupt test.

- [ ] **Step 6: Verify the smoke test passes**

Run: `npm run build && node scripts/package-smoke.mjs`
Expected: `Tarball install, both aliases, ESM/CJS exports, declarations, HTTP CLI, interrupt cleanup, and bank creation pass.`

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts tests/cli.test.ts scripts/package-smoke.mjs
git commit -m "feat: add --pass-env for variables a CLI login needs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Documentation and release checks

**Files:**
- Modify: `docs/transports.md`, `SECURITY.md`, `docs/library.md`, `docs/cli.md`, `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Apply the spec's "Documentation changes" verbatim**, in the files and positions it names.

- [ ] **Step 2: Check that no stale claim remains**

Run: `grep -n "inherits your environment except\|inherit the environment except\|the CLI inherits yours" README.md SECURITY.md docs/*.md`
Expected: no output.

Run: `grep -c "pass-env\|passEnv" README.md SECURITY.md docs/transports.md docs/library.md docs/cli.md CHANGELOG.md`
Expected: at least 1 in each file.

- [ ] **Step 3: Full checks**

Run: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run && npm run build && node scripts/package-smoke.mjs`
Expected: all pass. `tests/evaluation-report.test.ts` still passes, because neither bank changed.

- [ ] **Step 4: Scan the branch for local paths**

Run: `git diff main --name-only && git diff main -- . ':!specs' | grep -nE '/Use[r]s/|/priva[t]e/|/ho[m]e/[a-z]|scratchpad' ; git log main..HEAD --format=%B | grep -nE '/Use[r]s/|/priva[t]e/|scratchpad' ; grep -nE '/Use[r]s/[a-z]|/priva[t]e/tmp' specs/2026-11-21-driver-environment-allowlist-*.md`
Expected: the file list contains only files named in this plan, and the three greps print nothing.

- [ ] **Step 5: Commit**

```bash
git add docs/transports.md SECURITY.md docs/library.md docs/cli.md README.md CHANGELOG.md
git commit -m "docs: describe the CLI driver environment allowlist and --pass-env" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
