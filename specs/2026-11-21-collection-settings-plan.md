# Per-Model Collection Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every bank model records its collection settings in a structured `collection` field. The CLI applies the recorded output budget, and the token-limit field when the format matches, for an enrolled `--model`.

**Architecture:**
- `CollectionSettings` is a type in `src/core/types.ts` and is validated in `validateBank`.
- `src/data/collection_settings.ts` provides three functions:
  - `parseCollectionSettings` reads the uniform provenance string;
  - `withCollectionSettings` fills a missing field;
  - `collectionSettingsFor` finds an enrolled model by `--model`.
- The updater writes the field for collected models and fills it for retained and refitted ones. The two bundled banks are filled once.
- The CLI loads the bank before building its HTTP client, so it can apply settings that options do not set.

**Tech Stack:** TypeScript ESM on Node ≥ 22, vitest. No new dependencies.

**Spec:** `specs/2026-11-21-collection-settings-design.md`

**Branch:** `feat/collection-settings`, created from local `main` at `df457e2` (5 commits ahead of `origin/main`).

## Global Constraints

- `collection` is optional and additive. The schema version does not change, scoring does not change, and options given on the command line always win.
- The CLI never changes `--provider` or `--api-format`.
- The bundled banks change only by the added `collection` objects. Everything else stays as it is, and regenerating the evaluation leaves every count unchanged.
- No provider requests.
- The repository is public under a pseudonymous identity: no absolute paths, local username or scratchpad paths in commits, specs or docs.
- In the maintainer's shell, `npm` may be the Socket wrapper. Verify with `./node_modules/.bin/tsc --noEmit` and `./node_modules/.bin/vitest run`, build with `npm run build`, and run scripts with `node`.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A bank model without `collection`, as in a custom bank, keeps today's defaults and prints no note (Task 3 test `leaves a model without collection settings at the default budget`).
2. Options given on the command line win, and a token-limit field is never applied across API formats (Task 3 test `keeps explicit options and only notes a different API format`).
3. The bundled banks change only by the added `collection` objects (Task 2 step 4: removing them must reproduce `main`'s files byte for byte).
4. A retained or refitted model from an older bank gets its settings from provenance (Task 2 tests `fills a retained model's …` and `fills a reused model's …`).
5. Regenerating the evaluation changes no count (Task 2 step 6).

---

### Task 1: The `collection` field, its parser and its lookup

**Files:**
- Create: `src/data/collection_settings.ts`
- Modify: `src/core/types.ts` (`CollectionSettings`, `ModelFingerprint.collection?`), `src/data/bank_loader.ts` (validation), `src/index.ts` (export `collectionSettingsFor` and `type CollectionSettings`)
- Test: `tests/collection-settings.test.ts`

**Interfaces:**
- Produces:
  - `interface CollectionSettings { provider: 'openai' | 'openrouter' | 'google' | 'cloudflare'; route: string; apiFormat: 'chat-completions' | 'responses' | 'messages'; tokenLimitField: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'; maxTokens: number; collectedAt: string; corpusSha256: string }`
  - `parseCollectionSettings(provenance: string): CollectionSettings | undefined`. It reads:
    - the provider from the leading `PROVIDER_LABELS` label followed by `; `;
    - `; collected <time>;`, `corpus sha256:<64 hex>;`, `; model=<route>;` and `; api=<format>;`;
    - `; <field>=<integer>;` for the field.
    It returns `undefined` if any of these is missing.
  - `withCollectionSettings(model: ModelFingerprint): ModelFingerprint`. It returns `model` itself when `collection` is present or provenance does not parse. Otherwise it returns `{ ...model, collection }`, so `collection` comes last.
  - `collectionSettingsFor(bank: FingerprintBank, model: string): { id: string; collection: CollectionSettings } | undefined`. It matches the last `/` segment of `model` against model ids, ignoring case, and only among models that have `collection`.
  - `validateBank` rejects an invalid `collection` with `INVALID_BANK` `Invalid bank: collection settings`. It is invalid when:
    - the provider or format is unknown;
    - the route is empty or longer than 256 characters;
    - the field does not fit the format;
    - `maxTokens` is not an integer from `protocol.targetSamples` to 262,144;
    - `collectedAt` is not an ISO UTC time;
    - `corpusSha256` is not 64 lowercase hex digits.

- [ ] **Step 1: Write the failing tests** in `tests/collection-settings.test.ts`

Use `D = 'a'.repeat(64)` and `tail = '; labels are requested catalog identities, not independent model attestation'`.

- `parses each recorded format`. These three provenance strings parse as follows:

| Provenance | Parsed value |
| --- | --- |
| `` `OpenAI API; collected 2026-11-06T22:22:10.199Z; integer-v1; corpus sha256:${D}${tail}; model=gpt-6-astra; api=chat-completions; stream=false; training=10; validation=5; sampling=first-512; max_completion_tokens=8192; cache=none` `` | `{ provider: 'openai', route: 'gpt-6-astra', apiFormat: 'chat-completions', tokenLimitField: 'max_completion_tokens', maxTokens: 8192, collectedAt: '2026-11-06T22:22:10.199Z', corpusSha256: D }` |
| `` `OpenRouter API; collected 2026-11-11T13:08:34.175Z; integer-v1; corpus sha256:${D}${tail}; model=anthropic/claude-fable-5.2; api=messages; stream=false; training=10; validation=5; sampling=first-512; max_tokens=16384; cache=bypassed` `` | provider `openrouter`, route `anthropic/claude-fable-5.2`, `messages`, `max_tokens`, 16384 |
| `` `Google AI Studio Gemini API; collected 2026-11-19T22:49:17.038Z; integer-v1; corpus sha256:${D}${tail}; model=gemini-4-neon; api=chat-completions; stream=false; training=10; validation=5; sampling=first-512; max_tokens=65536; cache=none` `` | provider `google`, `chat-completions`, `max_tokens`, 65536 |

- `returns nothing for provenance without collection settings`: `parseCollectionSettings('SYNTHETIC TEST FIXTURE; no real model measurements')` is `undefined`.
- `fills only a missing collection`:
  - a model whose provenance is the first string, without `collection`, gets the parsed value;
  - a model that already has `collection` comes back as the same object (`toBe`);
  - a synthetic model comes back unchanged.
- `finds an enrolled model by its route or id, ignoring case and vendor prefix`:
  - set up `syntheticBank()` with the first parsed value as `models[0].collection`;
  - `'vendor/SYNTHETIC-17'` gives `{ id: 'synthetic-17', collection }`;
  - `'synthetic-1'` gives `undefined`, and so does `'synthetic-287'`, which has no `collection`.
- `validates collection settings`:
  - the bank above passes `validateBank`;
  - copies with each change below throw `/Invalid bank: collection settings/`: `apiFormat: 'grpc'`; `tokenLimitField: 'max_output_tokens'` (with `chat-completions`); `maxTokens: 100` (below `targetSamples` 128); `corpusSha256: 'xyz'`; `provider: 'azure'`; `route: ''`; `collectedAt: 'yesterday'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/collection-settings.test.ts`
Expected: FAIL, the module cannot be found.

- [ ] **Step 3: Implement** the interfaces above. `PROVIDER_LABELS` comes from `src/data/gateway_plan.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit`
Expected: PASS, the whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/data/collection_settings.ts src/data/bank_loader.ts src/index.ts tests/collection-settings.test.ts specs/2026-11-21-collection-settings-design.md specs/2026-11-21-collection-settings-plan.md
git commit -m "feat: describe each model's collection settings in a structured field" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Fill the field in the updater, the refit and the bundled banks

**Files:**
- Modify: `src/data/gateway_update.ts` (`enroll()` writes `collection`; `merge()` applies `withCollectionSettings`), `src/data/pooled_refit.ts` (the selected models get `withCollectionSettings`), `src/maintainer.ts` (export `withCollectionSettings` and `parseCollectionSettings`), `src/data/default_bank.json`, `src/data/pooled_bank.json`, `docs/evaluation.json`, `docs/evaluation.md`
- Test: `tests/gateway-update.test.ts`, `tests/pooled-refit.test.ts`, `tests/collection-settings.test.ts`

**Interfaces:**
- Consumes: Task 1's functions.
- Produces: in `enroll()`, each collected model gets `collection = { provider: target.provider, route: target.model, apiFormat: target.apiFormat, tokenLimitField: target.tokenLimitField, maxTokens: target.maxTokens, collectedAt, corpusSha256: digest }`, assigned after `provenance`.

- [ ] **Step 1: Write the failing tests**

- `tests/gateway-update.test.ts`:
  - In `enrolls all three API formats with the same integer prompt and Cloudflare auth`, add:
    - `expect(bank.models[0]!.collection).toMatchObject({ provider: 'cloudflare', route: 'openai/reference-a', apiFormat: 'responses', tokenLimitField: 'max_output_tokens' })`;
    - `expect(bank.models[1]!.collection).toMatchObject({ apiFormat: 'messages', tokenLimitField: 'max_tokens', maxTokens: 8192 })`;
    - for every model, `collection.corpusSha256` equals the digest in its provenance, and `collection` equals `parseCollectionSettings(provenance)`.
  - New `fills a retained model's missing collection settings from its provenance`:
    - set up as `probes only new models and merges them after the enrolled models`, but write the base bank with `collection` deleted from every model;
    - run the same incremental update;
    - each saved retained model's `collection` is defined and equals `parseCollectionSettings(model.provenance)`.
- `tests/pooled-refit.test.ts`, new `fills a reused model's missing collection settings from its provenance`: delete `collection` from `old.bank.models`, then `refitPooledBank(pooledConfig(), [fresh, old]).models[2].collection` equals `parseCollectionSettings(old.bank.models[1].provenance)`.
- `tests/collection-settings.test.ts`, new `the bundled banks record every model's collection settings`:
  - for each model of `defaultBank()` and `await pooledBank()`, `collection` is defined and equals `parseCollectionSettings(provenance)`;
  - spot checks:
    - default `gpt-6-astra` is `{ apiFormat: 'chat-completions', tokenLimitField: 'max_completion_tokens', maxTokens: 8192 }`;
    - default `claude-fable-5.2` is `{ provider: 'openrouter', route: 'anthropic/claude-fable-5.2', maxTokens: 16384 }`;
    - default `gemini-4-neon` is `{ provider: 'google', maxTokens: 65536 }`;
    - pooled `claude-fable-5.2` has `{ maxTokens: 4096 }`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/gateway-update.test.ts tests/pooled-refit.test.ts tests/collection-settings.test.ts`
Expected: FAIL, because `collection` is undefined everywhere.

- [ ] **Step 3: Implement `enroll()`, `merge()`, the refit and the maintainer exports**

Run: `./node_modules/.bin/vitest run tests/gateway-update.test.ts tests/pooled-refit.test.ts`
Expected: PASS. If an existing test compares whole model objects and now differs only by the new `collection` field, update its expectation and ledger a ruling.

- [ ] **Step 4: Fill both bundled banks once and check the diff**

Run: `npm run build`, then for each of `src/data/default_bank.json` and `src/data/pooled_bank.json`, run a `node --input-type=module` snippet that:
- imports `withCollectionSettings` from `./build/maintainer.js`;
- replaces `bank.models` with `bank.models.map(withCollectionSettings)`;
- writes `` `${JSON.stringify(bank, null, 2)}\n` `` back.

Check: for each file, a `node --input-type=module` snippet deletes `collection` from every model of the new file and serializes it the same way. The result must equal `git show main:<file>` byte for byte, which shows that nothing else changed. Each model's `provenance` line only gains a trailing comma.

- [ ] **Step 5: Run the bundled-bank test**

Run: `./node_modules/.bin/vitest run tests/collection-settings.test.ts`
Expected: PASS.

- [ ] **Step 6: Regenerate the evaluation report**

Run: `npm run build && node scripts/evaluate-banks.mjs`

Expected: the five status lines are identical to the committed report's (460 / 152 / 0 / 303 / 5; 460 / 18 / 413 / 29; 225 / 0 / 223 / 2; 300 / 116 / 42 / 103 / 39 / 0; 350 / 51 / 0 / 299 / 0). In the `git diff` of `docs/evaluation.md`, only the two bank SHA-256 lines change. **If anything else differs, stop and report.**

- [ ] **Step 7: Run the full suite and commit**

Run: `./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit`
Expected: PASS.

```bash
git add src/data/gateway_update.ts src/data/pooled_refit.ts src/maintainer.ts src/data/default_bank.json src/data/pooled_bank.json docs/evaluation.json docs/evaluation.md tests/gateway-update.test.ts tests/pooled-refit.test.ts tests/collection-settings.test.ts
git commit -m "feat: record collection settings in both bundled banks and the updater" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: The CLI applies an enrolled model's settings

**Files:**
- Modify: `src/cli.ts` (load the bank before the transport; apply settings; notes; `--max-tokens` help text), `tests/fixtures.ts` (new `collectionBank()`)
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `collectionSettingsFor`, `defaultBank`, `loadBank` and `pooledBank`.
- Produces:
  - The CLI resolves the bank (`--pooled`, `--bank`, or `bankLoader.defaultBank()`) before it constructs `HttpClient`. In API mode it calls `collectionSettingsFor(bank, options.model)`. On a match:
    - **Budget:** if `--max-tokens` is unset, set it to `collection.maxTokens`.
    - **Token-limit field:** let `format` be `messages` for `--provider anthropic`, `responses` for `--api-format responses`, else `chat-completions`. If `format === collection.apiFormat` and `--token-limit-field` is unset, set it to `collection.tokenLimitField`.
    - **Note on what was applied**, if anything: `Note: using <id>'s collection settings from the bank: <applied, comma-separated, as "--max-tokens 4096" and "--token-limit-field max_completion_tokens">.`
    - **Note on a different format:** if `format !== collection.apiFormat`, write `Note: the bank collected <id> through <Chat Completions | Responses | Anthropic Messages>; add <flags> to match it.` The flags are `--provider openai --api-format chat-completions`, `--provider openai --api-format responses` or `--provider anthropic`.
    - Both notes go to stderr, in the same style as the existing withheld-key note.
  - `--max-tokens` help text: `output token budget per integer request (default: the budget the bank recorded for --model, otherwise samples × 5 + 64); reasoning models need more`.
  - `tests/fixtures.ts`: `collectionBank(): FingerprintBank` is `syntheticBank()` with `models[0].collection = { provider: 'openai', route: 'synthetic-17', apiFormat: 'chat-completions', tokenLimitField: 'max_completion_tokens', maxTokens: 4096, collectedAt: '2026-01-01T00:00:00.000Z', corpusSha256: 'a'.repeat(64) }`.

- [ ] **Step 1: Write the failing tests** in `tests/cli.test.ts`

Each test sets `vi.spyOn(bankLoader, 'defaultBank').mockImplementation(collectionBank)` and `vi.stubEnv('LOGITPING_API_KEY', 'tool-key')`. Each mocks `fetch` to record `JSON.parse(String(init?.body))` and answer `sse('17 '.repeat(128))`, then runs `main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', …, '--no-tokenizer', '--json'])`.

- `applies a matching model's recorded budget and token-limit field` (`--model vendor/synthetic-17`):
  - the request body has `max_completion_tokens: 4096` and no `max_tokens`;
  - `stderr` contains `using synthetic-17's collection settings from the bank: --max-tokens 4096, --token-limit-field max_completion_tokens.`
- `keeps explicit options and only notes a different API format` (`--model synthetic-17 --api-format responses --max-tokens 1000`):
  - the body has `max_output_tokens: 1000`;
  - `stderr` contains `the bank collected synthetic-17 through Chat Completions; add --provider openai --api-format chat-completions to match it.` and not `collection settings from the bank`.
- `leaves a model without collection settings at the default budget` (`--model synthetic-287`):
  - the body has `max_tokens: 704`, which is 128 × 5 + 64;
  - `stderr` does not contain `Note: using` or `the bank collected`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/cli.test.ts`
Expected: FAIL on the first two tests. The budget is 704 instead of 4096, and no notes appear.

- [ ] **Step 3: Implement** the interfaces above in `src/cli.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit`
Expected: PASS, the whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts tests/fixtures.ts
git commit -m "feat: apply an enrolled model's recorded budget in the CLI" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Documentation and release checks

**Files:**
- Modify: `README.md`, `docs/bank.md`, `docs/cli.md`, `docs/library.md`, `docs/bank-maintenance.md`, `CHANGELOG.md`

- [ ] **Step 1: Apply the spec's "Documentation changes" verbatim.** The help-text change is done in Task 3.

- [ ] **Step 2: Check the docs**

Run: `grep -n "The probe CLI defaults to 2,624 output tokens\|  --max-tokens 8192 \\\\" README.md docs/bank.md`
Expected: no output.

Run: `grep -c "collection" README.md docs/bank.md docs/cli.md docs/library.md docs/bank-maintenance.md CHANGELOG.md`
Expected: at least 1 in each file.

- [ ] **Step 3: Full checks**

Run: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run && npm run build && node scripts/package-smoke.mjs`
Expected: all pass.

- [ ] **Step 4: Scan the branch for local paths**

Run: `git diff main --name-only && git diff main -- . ':!specs' | grep -nE '/Use[r]s/[A-Za-z]|/priva[t]e/tmp|scratchpad' ; git log main..HEAD --format=%B | grep -nE '/Use[r]s/|/priva[t]e/|scratchpad' ; grep -nE '/Use[r]s/[a-z]|/priva[t]e/tmp' specs/2026-11-21-collection-settings-*.md`
Expected: only files named in this plan, and the three greps print nothing.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/bank.md docs/cli.md docs/library.md docs/bank-maintenance.md CHANGELOG.md
git commit -m "docs: describe recorded collection settings and the CLI's automatic budget" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
