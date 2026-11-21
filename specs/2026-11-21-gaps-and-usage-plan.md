# Likelihood Gaps and Reported Token Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Results stop reporting IID confidence and per-model softmax weights. Scores carry log-likelihood gaps instead. API probes record the token counts each provider reports, reading each stream briefly past the last needed integer to catch counts that arrive late.

**Architecture:**
- `classify()` sets `logLikelihoodGap` from the sequential test's log likelihoods. It already reads them for candidates.
- Format adapters collect the usage fields of SSE events, and `HttpClient` reports changes through `ProbeRequest.onUsage`.
- For transports that declare `reportsUsage`, `collectIntegers()` keeps reading, without parsing, for up to `USAGE_GRACE_MS` after the count is reached, ignoring errors in that tail.
- `fingerprint()` returns one usage entry per integer request.

**Tech Stack:** TypeScript ESM on Node ≥ 22, vitest (fake timers for the grace period). No new dependencies.

**Spec:** `specs/2026-11-21-gaps-and-usage-design.md`

**Branch:** `feat/gaps-and-usage`, created from local `main` at `9bd3731`.

## Global Constraints

- **Intended breaking changes:** remove `ProbeResult.confidence`, `ProbeResult.confidenceMeaning` and `ModelScore.weight`.
- **Additions:** `ModelScore.logLikelihoodGap`, `TokenUsage`, `ProbeRequest.onUsage`, `ProbeTransport.reportsUsage` and `ProbeResult.usage`. Nothing else in the public API changes.
- Statuses, models, candidates and the naming rule stay as they are. The evaluation report must still pass `tests/evaluation-report.test.ts` unchanged, because neither bank changes.
- `USAGE_GRACE_MS` is 5,000. Early stops and transports without `reportsUsage` keep aborting at once.
- No provider requests.
- The repository is public under a pseudonymous identity: no absolute paths, local username or scratchpad paths in commits, specs or docs.
- In the maintainer's shell, `npm` may be the Socket wrapper. Verify with `./node_modules/.bin/tsc --noEmit` and `./node_modules/.bin/vitest run`, build with `npm run build`, and run scripts with `node`.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A stream that keeps going after the last needed integer stops within 5 s, and the probe still returns its result (Task 3 test `stops reading 5 s after the last needed integer`).
2. An error or abort in that tail does not turn a complete probe into `ERROR` (Task 3 test `ignores an error after the last needed integer`).
3. Transports without `reportsUsage`, and early stops, still abort at the count, and the former report no `usage` (Task 3 tests).
4. Malformed usage values never reach the result (Task 2 test `ignores malformed usage`).
5. The most likely model's gap is exactly 0, and the runner-up's gap equals the analytic value (Task 1 test).

---

### Task 1: Likelihood gaps replace confidence and weights

**Files:**
- Modify: `src/core/types.ts` (remove `confidence`, `confidenceMeaning` and `ModelScore.weight`; add `logLikelihoodGap`), `src/core/engine.ts` (classifications, pooled results, `relabel`, result assembly, warning text), `src/cli.ts` (`display()`)
- Test: `tests/engine.test.ts`, `tests/cli.test.ts`, `tests/pooled-engine.test.ts`, and any other test that names `confidence` or a score's `weight`

**Interfaces:**
- Produces:
  - `ModelScore.logLikelihoodGap: number | null`. When a sequential test exists and at least one envelope accepts, it is `max(decision.logLikelihoods) − decision.logLikelihoods[id]` for every scored model, and `null` otherwise.
  - The warning `The naming threshold assumes independent integers from fixed distributions; LLM integers are dependent, so validate error rates empirically.` replaces the "Nominal confidence …" one.
  - `display()` no longer prints a confidence line. It sorts scores by gap, with `null` last. Each line starts `  <id>: <gap> · H=…`, where `<gap>` is `0.0 nats` when the gap rounds to `0.0`, otherwise `−<gap to 1 decimal> nats` (U+2212), or `unranked`.

- [ ] **Step 1: Update and add the failing tests**

- Run `grep -n "confidence\|\.weight\|weight:" tests/*.ts`. For every hit about a result's `confidence` or a score's `weight`, apart from pooled pair `weights` and `SequentialDecision.weights`:
  - change `confidence` expectations to `expect(result).not.toHaveProperty('confidence')`;
  - change `weight` expectations to the matching `logLikelihoodGap` expectation:
    - where a weight above 0.995 was expected, the identified model's gap is `0`;
    - where `weight: null` was expected, `logLikelihoodGap: null`.
- `tests/engine.test.ts`, in `lists the models the sequential test cannot reject, most likely first`, add:
  - `model-a` has `logLikelihoodGap` `0`;
  - `model-b`'s gap is close to `128 * Math.log(192.5 / 189.5)` (6 digits);
  - `model-c`'s gap is above `Math.log(400)`;
  - `expect(result).not.toHaveProperty('confidenceMeaning')`.
- `tests/cli.test.ts`, in `prints the candidates of an inconclusive single-request probe`, add:
  - `stdout` contains `model-a: 0.0 nats` and `model-b: −2.0 nats`;
  - it contains neither `%` nor `Nominal model-relative confidence`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/engine.test.ts tests/cli.test.ts tests/pooled-engine.test.ts`
Expected: FAIL, because `confidence` and `weight` are still set and gaps are undefined.

- [ ] **Step 3: Implement** the interfaces above.
  - Every `confidence: null` and `confidence: winner.weight` disappears from `engine.ts`.
  - So does `confidenceMeaning` from both result objects.
  - The `Classification` pick no longer names `confidence`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit`
Expected: PASS, the whole suite. That includes the evaluation tests, which read only `status`, `model` and `candidates`.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/engine.ts src/cli.ts tests specs/2026-11-21-gaps-and-usage-design.md specs/2026-11-21-gaps-and-usage-plan.md
git commit -m "feat: report likelihood gaps instead of IID confidence and weights" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Parse the token usage providers report

**Files:**
- Modify: `src/core/types.ts` (`TokenUsage`, `ProbeRequest.onUsage`, `ProbeTransport.reportsUsage`), `src/core/formats.ts` (`StreamState.usage`, collection in the three stream states), `src/core/client.ts` (`reportsUsage = true`; call `onUsage` when the usage changes)
- Test: `tests/client.test.ts`

**Interfaces:**
- Produces:
  - `interface TokenUsage { inputTokens: number | null; outputTokens: number | null }`.
  - `ProbeRequest.onUsage?: (usage: TokenUsage) => void`.
  - `ProbeTransport.reportsUsage?: boolean`.
  - `StreamState.usage: TokenUsage`, starting `{ inputTokens: null, outputTokens: null }`. A field is overwritten only by a nonnegative safe integer, read from:
    - Chat: `payload.usage.prompt_tokens` / `completion_tokens`;
    - Responses: `response.completed` or `response.incomplete` `response.usage.input_tokens` / `output_tokens`;
    - Messages: `message_start` `message.usage.input_tokens` / `output_tokens`, and `message_delta` `usage.output_tokens`.
  - After each `parser.feed`, `HttpClient.stream()` calls `request.onUsage({ ...state.usage })` if the usage differs from what it last reported.

- [ ] **Step 1: Write the failing tests** in `tests/client.test.ts`, reusing its `event`, `delta` and `mockFetch` helpers.

Each test records the `onUsage` calls into an array and collects the stream.

- `reports Chat Completions usage from its final chunk`: the body `delta('1 2 3 ')` + `event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 52, completion_tokens: 7 } })` + `'data: [DONE]\n\n'` makes the last call `{ inputTokens: 52, outputTokens: 7 }`.
- `reports Responses usage from response.completed`: with `apiFormat: 'responses'`, the body `event({ type: 'response.output_text.delta', delta: '1 2 ' })` + `event({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 41, output_tokens: 9 } } })` makes the last call `{ inputTokens: 41, outputTokens: 9 }`.
- `reports Anthropic usage from message_start, then message_delta`:
  - with `provider: 'anthropic'`, the body is `event({ type: 'message_start', message: { usage: { input_tokens: 33, output_tokens: 1 } } })` + `event({ type: 'content_block_delta', delta: { type: 'text_delta', text: '1 2 ' } })` + `event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } })` + `event({ type: 'message_stop' })`;
  - the calls equal `[{ inputTokens: 33, outputTokens: 1 }, { inputTokens: 33, outputTokens: 12 }]`.
- `ignores malformed usage`: Chat usage `{ prompt_tokens: -1, completion_tokens: '7' }` produces no call.
- `declares that it reports usage`: `new HttpClient({ provider: 'openai', baseURL: 'https://api.example/v1', model: 'm' }).reportsUsage` is `true`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/client.test.ts`
Expected: FAIL, because `onUsage` is never called and `reportsUsage` is undefined.

- [ ] **Step 3: Implement** the interfaces above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/formats.ts src/core/client.ts tests/client.test.ts
git commit -m "feat: parse the token usage providers report in their streams" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Read to the final event and report usage

**Files:**
- Modify: `src/core/engine.ts` (`USAGE_GRACE_MS`; `collectIntegers()` tail and usage; pooled collection; result `usage`), `src/cli.ts` (`display()` usage line)
- Test: `tests/engine.test.ts`, `tests/pooled-engine.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: Task 2's `TokenUsage`, `onUsage` and `reportsUsage`.
- Produces:
  - `export const USAGE_GRACE_MS = 5_000` in `engine.ts`.
  - `collectIntegers()` passes `onUsage` when `transport.reportsUsage`, keeping the latest non-null value of each field. It returns `usage: TokenUsage`.
  - When the count is reached without an early stop, a `reportsUsage` transport goes on as follows:
    - parsing stops;
    - an unref'd timer aborts the scope after `USAGE_GRACE_MS`;
    - the loop drains the stream until it ends;
    - any error or abort from then on is swallowed, and the timer is cleared.
  - Otherwise behavior is today's: abort at once.
  - `parser.finish()` runs only if the count was not reached.
  - `fingerprint()` adds `usage: TokenUsage[]` when `transport.reportsUsage`: one entry for a single request; for a pooled probe, one per request sent, in order, including the short or repeated one.
  - `display()` prints after the integer count line: `Reported tokens (input/output): <in>/<out>`, with pooled pairs joined by `, ` and `?` for `null`.

- [ ] **Step 1: Write the failing tests**

In `tests/engine.test.ts`, add `class UsageTransport implements ProbeTransport` with:
- `name = 'openai'`, `granularity = 'token'`, `reportsUsage = true`, `aborted = false`;
- a constructor taking `(chunks: string[], usage: TokenUsage | null, tail: 'end' | 'stall' | 'error')`;
- `stream(request)` behaves as follows:
  - it yields the chunks;
  - it calls `request.onUsage` with `usage` if given;
  - for `'stall'` it waits until `request.signal` aborts, and for `'error'` it throws `new Error('late stream error')`;
  - in `finally` it records `aborted = request.signal?.aborted ?? false`.

Tests, all with `syntheticBank()` and `earlyStopping: false` unless stated:
- `reads to the end of the stream for usage after the last needed integer`: chunks `['17 '.repeat(128)]`, usage `{ inputTokens: 52, outputTokens: 700 }` and `'end'` give `status: 'IDENTIFIED'` and `usage: [{ inputTokens: 52, outputTokens: 700 }]`.
- `stops reading 5 s after the last needed integer`:
  - set up `vi.useFakeTimers()`, the same chunks, usage `null` and `'stall'`;
  - the promise has not settled after `advanceTimersByTimeAsync(4_900)`;
  - it has settled after another `advanceTimersByTimeAsync(200)`;
  - the result is `IDENTIFIED` with `usage: [{ inputTokens: null, outputTokens: null }]`, and the transport was aborted;
  - restore real timers in `finally`.
- `ignores an error after the last needed integer`: usage `{ inputTokens: 52, outputTokens: 700 }` and `'error'` give `IDENTIFIED` with that usage.
- `still aborts at once on an early stop`: `syntheticBank()` with early stopping, 128 × `'17 '` and `'stall'` give `earlyStopped: true` with real timers. It must finish within the 10 s test timeout without fake-timer help.
- `reports no usage for a transport that does not declare it`: `MemoryTransport` gives a result without a `usage` property.

In `tests/pooled-engine.test.ts`:
- `reports one usage entry per pooled request`: build a `reportsUsage` transport answering 4 requests with distinct runs, each reporting `{ inputTokens: 52, outputTokens: 100 + i }`. Use `forceCutoffs(openEnvelopes(syntheticPooledBank(4)), …)` as the existing tests do. `result.usage` has 4 entries, `outputTokens` 100–103 in order.

In `tests/cli.test.ts`:
- `prints the reported token counts`: mock `fetch` with a Chat SSE body of `'17 '.repeat(128)`, then a chunk with `usage: { prompt_tokens: 52, completion_tokens: 7 }`, then `[DONE]`, and run without `--json`. `stdout` contains `Reported tokens (input/output): 52/7`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/engine.test.ts tests/pooled-engine.test.ts tests/cli.test.ts`
Expected: FAIL. `usage` is absent, the stalled stream is aborted at once, and nothing prints.

- [ ] **Step 3: Implement** the interfaces above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit`
Expected: PASS, the whole suite, including the HTTP integration test and the evaluation report test.

- [ ] **Step 5: Commit**

```bash
git add src/core/engine.ts src/cli.ts tests/engine.test.ts tests/pooled-engine.test.ts tests/cli.test.ts
git commit -m "feat: read API streams to their final event and report token usage" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Documentation and release checks

**Files:**
- Modify: `README.md`, `docs/library.md`, `docs/cli.md`, `docs/methodology.md`, `SECURITY.md`, `CHANGELOG.md`

- [ ] **Step 1: Apply the spec's "Documentation changes" verbatim.**

- [ ] **Step 2: Check the docs**

Run: `grep -n "confidence" README.md docs/cli.md docs/library.md docs/methodology.md SECURITY.md`
Expected: no output. `docs/bank.md`'s historical figures and the changelog are exempt.

Run: `grep -c "usage\|logLikelihoodGap\|likelihood gaps" docs/cli.md docs/methodology.md CHANGELOG.md`
Expected: at least 1 in each file.

- [ ] **Step 3: Full checks**

Run: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run && npm run build && node scripts/package-smoke.mjs`
Expected: all pass.

- [ ] **Step 4: Scan the branch for local paths**

Run: `git diff main --name-only && git diff main -- . ':!specs' | grep -nE '/Use[r]s/[A-Za-z]|/priva[t]e/tmp|scratchpad' ; git log main..HEAD --format=%B | grep -nE '/Use[r]s/|/priva[t]e/|scratchpad' ; grep -nE '/Use[r]s/[a-z]|/priva[t]e/tmp' specs/2026-11-21-gaps-and-usage-*.md`
Expected: only files named in this plan, and the three greps print nothing.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/library.md docs/cli.md docs/methodology.md SECURITY.md CHANGELOG.md
git commit -m "docs: describe likelihood gaps and reported token usage" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
