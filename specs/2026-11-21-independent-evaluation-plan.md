# Independent Evaluation Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `npm run bank:evaluate`. It scores both bundled banks on every stored run they were not built from, writes a committed report that a test ties to the bank files, and the documentation is corrected with its numbers.

**Architecture:** The pure, unit-tested logic lives in `src/data/evaluation.ts` and is exported only through the maintainer build: corpus parsing and roles, default and pooled evaluation through the production `fingerprint()`, orchestration, and markdown rendering. `scripts/evaluate-banks.mjs` finds the git-ignored corpora and writes `docs/evaluation.json` and `docs/evaluation.md`. `tests/evaluation-report.test.ts` keeps the committed report in step with the banks in CI, where the corpora are absent.

**Tech Stack:** TypeScript ESM on Node ≥ 22, vitest, tsup (`build/maintainer.js`). No new dependencies.

**Spec:** `specs/2026-11-21-independent-evaluation-design.md`

**Branch:** `feat/independent-evaluation` (already created from `main` at `7475f19`).

## Global Constraints

- No provider requests anywhere: not in the tests, and not in the script.
- Do not change engine behavior, `src/data/default_bank.json` or `src/data/pooled_bank.json`.
- The report and committed docs contain no local paths: corpora appear only by SHA-256, and the banks by `src/data/default_bank.json` and `src/data/pooled_bank.json`.
- The repository is public under a pseudonymous identity. Commits, specs and docs must not contain absolute paths, the local username or scratchpad paths.
- Describe models only by their outputs. Never claim lineage or distillation between models.
- In the maintainer's shell, `npm` may be the Socket wrapper, which drops script flags and runs scripts under Node's permission model. Verify with `./node_modules/.bin/tsc --noEmit` and `./node_modules/.bin/vitest run`, build with `npm run build`, and run scripts with `node` directly.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. The same corpus present twice, as a copy or a second file, must be counted once, by content digest (Task 3 test `reads a copied corpus once`).
2. Running without corpora, for example in a contributor checkout, must fail and leave the committed report untouched (Task 3 test `refuses to run without corpora`; the Task 4 script writes only after success).
3. A corpus that is a bank's own for some models but holds independent or never-enrolled runs for others must be scored per model, like `163709a6…` and `74df5aa4…` (Task 1 test `scores never-enrolled models from every corpus, including a bank's own`).
4. A pooled probe that the engine stops because a reply repeats must count as `stopped`, never as `none` (Task 2 test `counts a probe stopped by a repeated reply apart from an empty set`).
5. A pooled model with fewer runs than one probe needs must produce no row and no error, and a run count that is not a multiple of the probe size must still give full-size groups (Task 2 tests `groupRuns` and `names the only candidate, skipping own runs and models with too few runs`).

---

### Task 1: Corpus parsing and default-bank evaluation

**Files:**
- Create: `src/data/evaluation.ts`
- Test: `tests/evaluation.test.ts`

**Interfaces:**
- Consumes: `fingerprint` (`src/core/engine.ts`), `corpusDigest` (`src/data/gateway_plan.ts`), `FingerprintBank` and `ProbeTransport` (`src/core/types.ts`), `INTEGER_MIN`/`INTEGER_MAX` (`src/math/ordered_block.ts`).
- Produces:
  - `interface StoredCorpus { collectedAt: string; protocol: FingerprintBank['protocol']; checkpoints: number[]; models: { id: string; training: number[][]; validation: number[][] }[] }`
  - `interface StatusTally { runs: number; correct: number; wrong: Record<string, number>; inconclusive: number; unknown: number }`
  - `interface CorpusTallies<T> { corpus: string; models: Record<string, T> }`
  - `interface DefaultResults { enrolled: CorpusTallies<StatusTally>[]; labelRemoved: CorpusTallies<StatusTally>[]; neverEnrolled: CorpusTallies<StatusTally>[] }`
  - `interface DigestedCorpus { digest: string; corpus: StoredCorpus }`
  - `parseStoredCorpus(value: unknown): DigestedCorpus`
  - `corpusRoles(bank: FingerprintBank, { digest, corpus }: DigestedCorpus): { independent: StoredCorpus['models']; neverEnrolled: StoredCorpus['models'] }`
  - `evaluateDefaultBank(bank: FingerprintBank, corpora: readonly DigestedCorpus[]): Promise<DefaultResults>`
  - Internal: `replay(responses: readonly (readonly number[])[]): ProbeTransport`, named `openai` with `granularity: 'token'`. It answers request *i* with `` `${responses[i].join(' ')} ` ``. Task 2 reuses it.

- [ ] **Step 1: Write the failing tests** in `tests/evaluation.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { createFingerprintBank } from '../src/data/enrollment.js';
import { evaluateDefaultBank, parseStoredCorpus, type StatusTally, type StoredCorpus } from '../src/data/evaluation.js';
import { corpusDigest } from '../src/data/gateway_plan.js';

const PROTOCOL = { id: 'integer-v1', language: 'en', targetSamples: 128, temperature: null, transport: 'openai' } as const;
const constant = (value: number, count: number) => Array.from({ length: count }, () => Array<number>(128).fill(value));
const model = (id: string, value: number, training: number, validation = 0) => ({ id, training: constant(value, training), validation: constant(value, validation) });
const corpus = (collectedAt: string, models: StoredCorpus['models']): StoredCorpus => ({ collectedAt, protocol: { ...PROTOCOL }, checkpoints: [64, 128], models });
const tally = (fields: Partial<StatusTally>): StatusTally => ({ runs: 0, correct: 0, wrong: {}, inconclusive: 0, unknown: 0, ...fields });

// The bank is fitted from `own`, which also holds a model it does not enroll (synthetic-200).
const own = corpus('2026-01-01T00:00:00.000Z', [model('synthetic-17', 17, 3, 2), model('synthetic-150', 150, 3, 2), model('synthetic-287', 287, 3, 2), model('synthetic-200', 200, 3, 2)]);
const ownDigest = corpusDigest(own);
const bank = createFingerprintBank({ source: `SYNTHETIC TEST FIXTURE; corpus sha256:${ownDigest}; no real model measurements`, protocol: PROTOCOL, checkpoints: [64, 128], models: own.models.slice(0, 3).map((m) => ({ ...m, family: 'synthetic' })) });
// Another collection. synthetic-150's runs are mislabeled 17s, so they are named wrongly.
const other = corpus('2026-01-02T00:00:00.000Z', [model('synthetic-17', 17, 2), model('synthetic-150', 17, 2), model('synthetic-200', 200, 2)]);
const otherDigest = corpusDigest(other);
```

Tests (`describe('stored corpora')` and `describe('default-bank evaluation')`):

- `parses a corpus and names it by its content digest`: `expect(parseStoredCorpus(JSON.parse(JSON.stringify({ schemaVersion: 1, ...own })))).toEqual({ digest: ownDigest, corpus: own })`. The returned corpus has exactly the four `StoredCorpus` fields.
- `rejects a run of the wrong length or out of range`: replacing `own.models[0]`'s training with `[[1, 2, 3]]`, and separately with `[Array(128).fill(356)]`, throws `/synthetic-17: every run must have 128 integers in \[1, 355\]/`.
- `rejects input that is not a corpus`: `parseStoredCorpus(null)` and `parseStoredCorpus({})` throw `/not a stored corpus/`.
- `skips own runs and scores independent runs against the full bank and without their model`. Call `evaluateDefaultBank(bank, [{ digest: ownDigest, corpus: own }, { digest: otherDigest, corpus: other }])`, then:
  - `results.enrolled` equals `[{ corpus: otherDigest, models: { 'synthetic-17': tally({ runs: 2, correct: 2 }), 'synthetic-150': tally({ runs: 2, wrong: { 'synthetic-17': 2 } }) } }]`;
  - `results.labelRemoved` equals `[{ corpus: otherDigest, models: { 'synthetic-17': tally({ runs: 2, unknown: 2 }), 'synthetic-150': tally({ runs: 2, wrong: { 'synthetic-17': 2 } }) } }]`.
- `scores never-enrolled models from every corpus, including a bank's own`: the same call gives `results.neverEnrolled` equal to `[{ corpus: ownDigest, models: { 'synthetic-200': tally({ runs: 5, unknown: 5 }) } }, { corpus: otherDigest, models: { 'synthetic-200': tally({ runs: 2, unknown: 2 }) } }]`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/evaluation.test.ts`
Expected: FAIL, `Cannot find module '../src/data/evaluation.js'` or equivalent.

- [ ] **Step 3: Implement in `src/data/evaluation.ts`**

- `parseStoredCorpus` checks that the value is an object with a string `collectedAt`, an object `protocol` whose `targetSamples` is an integer, an array `checkpoints`, and a `models` array of `{ id: string, training: array, validation: array }`. Otherwise it throws `Error('Input is not a stored corpus')`.
  - Every run must be an array of exactly `protocol.targetSamples` integers in `[INTEGER_MIN, INTEGER_MAX]`. Otherwise it throws `Error(`Corpus model ${id}: every run must have ${targetSamples} integers in [1, 355]`)`.
  - It returns `{ digest: corpusDigest(corpus), corpus }`, with `corpus` rebuilt from exactly those four fields.
- `corpusRoles` drops models the bank enrolls whose `provenance` includes `` `corpus sha256:${digest};` ``. Of the rest, enrolled ids are `independent` and the others are `neverEnrolled`. Corpus model order is kept.
- `evaluateDefaultBank`:
  - One `fingerprint(replay([run]), { bank, earlyStopping: false })` per run of `[...training, ...validation]`.
  - `labelRemoved` uses `{ ...bank, models: bank.models.filter((m) => m.id !== id) }`, built once per model.
  - Status mapping: `IDENTIFIED` with `model === id` → `correct`; any other `IDENTIFIED` → `wrong[model]++`; `INCONCLUSIVE` → `inconclusive`; `UNKNOWN_MODEL` → `unknown`; anything else throws `Error(`Unexpected ${status} for ${id}`)`.
  - Entries follow the corpus order. An entry is omitted when its corpus has no model in that role.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run tests/evaluation.test.ts && ./node_modules/.bin/tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/data/evaluation.ts tests/evaluation.test.ts specs/2026-11-21-independent-evaluation-design.md specs/2026-11-21-independent-evaluation-plan.md
git commit -m "feat: score the default bank on stored runs it was not built from" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Pooled-bank evaluation

**Files:**
- Modify: `src/data/evaluation.ts`
- Test: `tests/evaluation.test.ts`

**Interfaces:**
- Consumes: from Task 1, `DigestedCorpus`, `StoredCorpus`, `CorpusTallies`, `corpusRoles` and `replay`; `mulberry32` (`src/math/pooled_sets.ts`); `fingerprint`.
- Produces:
  - `interface SetTally { probes: number; correct: number; wrong: Record<string, number>; several: number; none: number; stopped: number }`
  - `interface PooledResults { groupings: number; requestsPerProbe: number; enrolled: CorpusTallies<SetTally>[]; neverEnrolled: CorpusTallies<SetTally>[] }`
  - `const EVALUATION_GROUPINGS = 10`, `const GROUPING_SEED = 20261107`
  - `groupRuns(count: number, size: number, grouping: number): number[][]`
  - `evaluatePooledBank(bank: FingerprintBank, corpora: readonly DigestedCorpus[], groupings = EVALUATION_GROUPINGS): Promise<PooledResults>`

- [ ] **Step 1: Write the failing tests** (append to `tests/evaluation.test.ts`)

```ts
import { createPooledBank } from '../src/data/pooled_enrollment.js';
import { evaluatePooledBank, groupRuns, type SetTally } from '../src/data/evaluation.js';
import { forceCutoffs, openEnvelopes, syntheticEnrollment, syntheticRun } from './fixtures.js';

const enrollment = syntheticEnrollment();   // synthetic-1-120, synthetic-118-237, synthetic-236-355
const pooledOwn: StoredCorpus = { collectedAt: '2026-01-01T00:00:00.000Z', protocol: enrollment.protocol, checkpoints: [64],
  models: enrollment.models.map(({ id, training, validation }) => ({ id, training, validation })) };
const pooledOwnDigest = corpusDigest(pooledOwn);
const pooled = (pass: boolean[]) => forceCutoffs(openEnvelopes(createPooledBank({ ...enrollment,
  source: `SYNTHETIC POOLED TEST FIXTURE; corpus sha256:${pooledOwnDigest}; no real model measurements`, requestsPerProbe: 4 })), pass);
const draws = (low: number, high: number, seed: number, count: number) => Array.from({ length: count }, (_, i) => syntheticRun(low, high, seed + i));
const fresh: StoredCorpus = { collectedAt: '2026-01-03T00:00:00.000Z', protocol: enrollment.protocol, checkpoints: [64], models: [
  { id: 'synthetic-1-120', training: draws(1, 120, 900, 8), validation: [] },
  { id: 'synthetic-118-237', training: draws(118, 237, 920, 8), validation: [] },
  { id: 'synthetic-236-355', training: draws(236, 355, 940, 3), validation: [] },
  { id: 'synthetic-never', training: draws(1, 355, 960, 8), validation: [] },
] };
const freshDigest = corpusDigest(fresh);
const sets = (fields: Partial<SetTally>): SetTally => ({ probes: 0, correct: 0, wrong: {}, several: 0, none: 0, stopped: 0, ...fields });
```

Tests (`describe('pooled-bank evaluation')`):

- `groupRuns`:
  - `groupRuns(40, 8, 0)` has length 5, and its first group is `[0, 5, 10, 15, 20, 25, 30, 35]`.
  - For groupings 0, 1 and 9, `groupRuns(41, 8, g)` gives 5 groups of 8 with 40 distinct indices.
  - `groupRuns(7, 8, 0)` is `[]`.
  - `groupRuns(40, 8, 3)` equals itself on a second call, and `groupRuns(40, 8, 1)` differs from `groupRuns(40, 8, 0)`.
- `names the only candidate, skipping own runs and models with too few runs`: `await evaluatePooledBank(pooled([true, false, false]), [{ digest: pooledOwnDigest, corpus: pooledOwn }, { digest: freshDigest, corpus: fresh }], 2)` equals:

```ts
{ groupings: 2, requestsPerProbe: 4,
  enrolled: [{ corpus: freshDigest, models: {
    'synthetic-1-120': sets({ probes: 4, correct: 4 }),
    'synthetic-118-237': sets({ probes: 4, wrong: { 'synthetic-1-120': 4 } }) } }],
  neverEnrolled: [{ corpus: freshDigest, models: { 'synthetic-never': sets({ probes: 4, wrong: { 'synthetic-1-120': 4 } }) } }] }
```

- `counts several candidates and empty sets`: with `pooled([true, true, false])`, `enrolled[0].models['synthetic-1-120']` is `sets({ probes: 4, several: 4 })`; with `pooled([false, false, false])`, it is `sets({ probes: 4, none: 4 })`.
- `counts a probe stopped by a repeated reply apart from an empty set`: a corpus whose only model, `synthetic-1-120`, has four identical runs (`syntheticRun(1, 120, 990)`), scored with `pooled([true, false, false])` and 2 groupings, gives `sets({ probes: 2, stopped: 2 })`.
- `rejects a bank without pooled scoring`: `evaluatePooledBank(bank, [], 2)`, using the Task 1 v1 bank, rejects with `/needs a pooled bank/`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/evaluation.test.ts`
Expected: FAIL, `groupRuns` and `evaluatePooledBank` are not exported.

- [ ] **Step 3: Implement `groupRuns` and `evaluatePooledBank` in `src/data/evaluation.ts`**

`groupRuns` must reproduce `scripts/research/pooled-eval.mjs`'s `partition()` whenever `count` is a multiple of `size`:

```ts
const groups = Math.floor(count / size);
if (!groups) return [];
const order = Array.from({ length: count }, (_, i) => i);
if (grouping) {
  const random = mulberry32(GROUPING_SEED + grouping);
  for (let i = count - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
}
return Array.from({ length: groups }, (_, group) => order.filter((_, position) => position % groups === group).slice(0, size));
```

`evaluatePooledBank`:
- Throw `Error('Pooled evaluation needs a pooled bank (schema version 2)')` unless `bank.schemaVersion === 2`. `size` is `bank.protocol.requestsPerProbe`.
- Per corpus and model in each role, and per grouping, probe each group with `fingerprint(replay(group.map((i) => runs[i])), { bank, earlyStopping: false })`.
- Mapping: `candidates === undefined` → `stopped`; one candidate → `correct` or `wrong[candidate]++`; more → `several`; none → `none`.
- Omit models with zero probes, and corpora with no rows.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run tests/evaluation.test.ts && ./node_modules/.bin/tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/evaluation.ts tests/evaluation.test.ts
git commit -m "feat: score the pooled bank on stored runs it was not built from" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Report assembly and rendering

**Files:**
- Modify: `src/data/evaluation.ts`, `src/data/gateway_plan.ts:58` (widen the `sameProtocol` parameter), `src/maintainer.ts`
- Test: `tests/evaluation.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 and 2; `validateBank` (`src/data/bank_loader.ts`); `sameProtocol`.
- Produces:
  - `sameProtocol(bank: FingerprintBank, config: { protocol: FingerprintBank['protocol'] }): boolean`. Existing callers are unchanged.
  - `interface BankSummary { file: string; sha256: string; models: number }`
  - `interface CorpusSummary { sha256: string; collectedAt: string; targetSamples: number; models: string[] }`
  - `interface EvaluationReport { schemaVersion: 1; banks: { default: BankSummary; pooled: BankSummary }; corpora: CorpusSummary[]; default: DefaultResults; pooled: PooledResults }`
  - `sha256(text: string): string`, the lowercase hex SHA-256 of the UTF-8 text.
  - `evaluateBanks(input: { default: { file: string; text: string }; pooled: { file: string; text: string }; corpora: readonly unknown[] }): Promise<EvaluationReport>`
  - `renderEvaluationReport(report: EvaluationReport): string`
  - `src/maintainer.ts` exports `evaluateBanks`, `renderEvaluationReport`, `sha256` and `type EvaluationReport`.

- [ ] **Step 1: Write the failing tests** (append; reuse `bank`, `own`, `other`, `fresh` and `pooled` from Tasks 1–2)

```ts
import { evaluateBanks, renderEvaluationReport, sha256, type EvaluationReport } from '../src/data/evaluation.js';
const input = (corpora: unknown[]) => ({
  default: { file: 'src/data/default_bank.json', text: JSON.stringify(bank) },
  pooled: { file: 'src/data/pooled_bank.json', text: JSON.stringify(pooled([true, false, false])) },
  corpora,
});
```

`describe('evaluation report')`:

- `records both banks by file and SHA-256, and corpora in collection order`. For `report = await evaluateBanks(input([other, own, fresh]))`:
  - `report.schemaVersion` is `1`;
  - `report.banks.default` equals `{ file: 'src/data/default_bank.json', sha256: sha256(JSON.stringify(bank)), models: 3 }`;
  - `report.corpora.map((c) => c.sha256)` equals `[ownDigest, otherDigest, freshDigest]`;
  - `report.corpora[0]` equals `{ sha256: ownDigest, collectedAt: own.collectedAt, targetSamples: 128, models: ['synthetic-17', 'synthetic-150', 'synthetic-287', 'synthetic-200'] }`;
  - `report.default.enrolled[0]!.corpus` is `otherDigest`, `report.pooled.neverEnrolled[0]!.corpus` is `freshDigest`, and `report.pooled.groupings` is `10`.
- `reads a copied corpus once`: `await evaluateBanks(input([other, structuredClone(other)]))` equals `await evaluateBanks(input([other]))`.
- `refuses a corpus that matches neither bank`: `input([{ ...other, protocol: { ...other.protocol, language: 'zh' } }])` rejects with `/matches neither bank/`.
- `refuses to run without corpora`: `input([])` rejects with `/No stored corpora/`.
- `refuses a bank file that is not a valid bank`: `{ ...input([other]), default: { file: 'src/data/default_bank.json', text: '{}' } }` rejects with `/Invalid bank/`.

`describe('rendered report')`, using this literal (`C = 'c'.repeat(64)`):

```ts
const report: EvaluationReport = { schemaVersion: 1,
  banks: { default: { file: 'src/data/default_bank.json', sha256: 'a'.repeat(64), models: 2 }, pooled: { file: 'src/data/pooled_bank.json', sha256: 'b'.repeat(64), models: 2 } },
  corpora: [{ sha256: C, collectedAt: '2026-10-11T02:51:23.401Z', targetSamples: 512, models: ['m1', 'm2'] }],
  default: {
    enrolled: [{ corpus: C, models: { m1: { runs: 3, correct: 1, wrong: { m3: 1, m2: 1 }, inconclusive: 1, unknown: 0 } } }],
    labelRemoved: [{ corpus: C, models: { m1: { runs: 3, correct: 0, wrong: { m2: 2 }, inconclusive: 0, unknown: 1 } } }],
    neverEnrolled: [] },
  pooled: { groupings: 10, requestsPerProbe: 8, enrolled: [],
    neverEnrolled: [{ corpus: C, models: { m9: { probes: 50, correct: 0, wrong: { m1: 3 }, several: 0, none: 47, stopped: 0 } } }] } };
```

The rendered markdown:
- starts with `'# Independent evaluation\n'` and ends with exactly one `'\n'`;
- contains each of these lines:
  - ``'| Default | `src/data/default_bank.json` | `' + 'a'.repeat(64) + '` | 2 |'``
  - ``'| `cccccccccccc` | 2026-10-11 | 512 | m1, m2 |'``
  - ``'| `cccccccccccc` | m1 | 3 | 1 | 2 (m2 1, m3 1) | 1 | 0 |'``
  - `'| **Total** | | 3 | 1 | 2 (m2 1, m3 1) | 1 | 0 |'`
  - ``'| `cccccccccccc` | m1 | 3 | 2 (m2 2) | 0 | 1 |'``
  - ``'| `cccccccccccc` | m9 | 50 | 3 (m1 3) | 0 | 47 | 0 |'``
- contains `'### Models the bank never enrolled\n\nNo runs.\n'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/evaluation.test.ts`
Expected: FAIL, `evaluateBanks` is not exported.

- [ ] **Step 3: Implement**

`evaluateBanks`:
- Validate each bank with `validateBank(JSON.parse(text))`. The pooled bank must be schema version 2.
- If `corpora` is empty, throw `Error('No stored corpora (*.corpus-*.json) were found; the report needs the maintainer corpora')`.
- Parse each corpus with `parseStoredCorpus`, and skip any digest already seen.
- Route each corpus to every bank for which `sameProtocol(bank, corpus)` holds. If none matches, throw `Error(`Corpus sha256:${digest} matches neither bank's protocol`)`.
- Sort corpora by `collectedAt`, then digest, before evaluating, then assemble the report.

`renderEvaluationReport` writes this layout. Everything is fixed except the values in angle brackets:

```
# Independent evaluation

<!-- Generated by `npm run bank:evaluate` from evaluation.json. Do not edit; rerun the command. -->

[Back to README](../README.md) · [Bank status](bank.md#evaluation-status) · [Bank maintenance](bank-maintenance.md#evaluate-the-bundled-banks)

Each bundled bank is scored on every stored run it was not built from, with the production engine and no provider requests. Corpora are named by the first 12 characters of their SHA-256.

| Bank | File | SHA-256 | Models |
| --- | --- | --- | --- |
| Default | `<file>` | `<sha256>` | <models> |
| Pooled | `<file>` | `<sha256>` | <models> |

## Corpora

| Corpus | Collected | Integers per run | Models |
| --- | --- | --- | --- |
| `<12 hex>` | <collectedAt YYYY-MM-DD> | <targetSamples> | <ids, comma-separated> |

## Default bank

### Enrolled models, runs from other collections
| Corpus | Model | Runs | Correct | Wrong | INCONCLUSIVE | UNKNOWN_MODEL |

### Same runs, tested model removed
| Corpus | Model | Runs | Named | INCONCLUSIVE | UNKNOWN_MODEL |

### Models the bank never enrolled
| Corpus | Model | Runs | Named | INCONCLUSIVE | UNKNOWN_MODEL |

## Pooled bank: <requestsPerProbe> requests per probe, <groupings> groupings

### Enrolled models, runs from other collections
| Corpus | Model | Probes | Correct | Wrong | Several | None | Stopped |

### Models the bank never enrolled
| Corpus | Model | Probes | Named | Several | None | Stopped |
```

- Each heading is followed by a blank line, then the table: header row, `| --- |` separator row, one row per corpus and model, then a `| **Total** | |` row summing every column. A section with no rows prints `No runs.` instead of a table.
- A `Wrong`/`Named` cell is `0`, or the total followed by `(id n, …)`, sorted by count descending, then id.
- Sections are separated by one blank line.

Export the four names from `src/maintainer.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit`
Expected: PASS, including the existing `tests/gateway-update.test.ts` and `tests/pooled-refit.test.ts` (callers of `sameProtocol`).

- [ ] **Step 5: Commit**

```bash
git add src/data/evaluation.ts src/data/gateway_plan.ts src/maintainer.ts tests/evaluation.test.ts
git commit -m "feat: assemble and render the independent evaluation report" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: `bank:evaluate` command and the committed report

**Files:**
- Create: `scripts/evaluate-banks.mjs`, `tests/evaluation-report.test.ts`, `docs/evaluation.json` and `docs/evaluation.md` (both generated)
- Modify: `package.json` (`scripts`)

**Interfaces:**
- Consumes: `evaluateBanks`, `renderEvaluationReport` and `sha256` from `build/maintainer.js` (script) and `src/data/evaluation.ts` (test).
- Produces: `npm run bank:evaluate`, `docs/evaluation.json` and `docs/evaluation.md`, which Task 5 cites.

- [ ] **Step 1: Write the failing test** `tests/evaluation-report.test.ts`

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderEvaluationReport, sha256, type EvaluationReport } from '../src/data/evaluation.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const json = read('docs/evaluation.json');
const report = JSON.parse(json) as EvaluationReport;

describe('committed evaluation report', () => {
  it('was generated from the bundled banks', () => {
    expect(report.banks.default).toMatchObject({ file: 'src/data/default_bank.json', sha256: sha256(read('src/data/default_bank.json')) });
    expect(report.banks.pooled).toMatchObject({ file: 'src/data/pooled_bank.json', sha256: sha256(read('src/data/pooled_bank.json')) });
  });
  it('renders to the committed markdown', () => {
    expect(read('docs/evaluation.md')).toBe(renderEvaluationReport(report));
  });
  it('records no local paths', () => {
    expect(json).not.toMatch(/\/Users\/|\/home\/|\/private\/|[A-Za-z]:\\\\/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./node_modules/.bin/vitest run tests/evaluation-report.test.ts`
Expected: FAIL with `ENOENT` for `docs/evaluation.json`.

- [ ] **Step 3: Implement `scripts/evaluate-banks.mjs` and the npm script**

- Resolve the repository root from `import.meta.url`, so the script works from any directory.
- Read every file in the root and in `src/data/` whose name matches `/\.corpus-[0-9a-f]{64}\.json$/`, parse it, and read both bank files as text.
- Call `evaluateBanks` with files `src/data/default_bank.json` and `src/data/pooled_bank.json`.
- Only after it succeeds, write `docs/evaluation.json` (`` `${JSON.stringify(report, null, 2)}\n` ``) and `docs/evaluation.md`.
- Print one total line per test, in this order and form:
  - `Default bank, enrolled: <runs> runs, <correct> correct, <wrong> wrong, <n> INCONCLUSIVE, <n> UNKNOWN_MODEL`
  - `Default bank, tested model removed: <runs> runs, <named> named, <n> INCONCLUSIVE, <n> UNKNOWN_MODEL`
  - `Default bank, never enrolled: <runs> runs, <named> named, <n> INCONCLUSIVE, <n> UNKNOWN_MODEL`
  - `Pooled bank, enrolled: <probes> probes, <correct> correct, <wrong> wrong, <n> several, <n> none, <n> stopped`
  - `Pooled bank, never enrolled: <probes> probes, <named> named, <n> several, <n> none, <n> stopped`
- On error, print only `error.message`, plus the basename of a corpus file that fails to parse, and set `process.exitCode = 1`.
- Add `"bank:evaluate": "npm run build && node scripts/evaluate-banks.mjs"` to `package.json` after `bank:pooled`.

- [ ] **Step 4: Generate the report and check it against the spec**

Run: `npm run build && node scripts/evaluate-banks.mjs`

Expected output includes:
- `Default bank, enrolled: 460 runs, 152 correct, 0 wrong, 303 INCONCLUSIVE, 5 UNKNOWN_MODEL`
- `Default bank, tested model removed: 460 runs, 18 named, 413 INCONCLUSIVE, 29 UNKNOWN_MODEL`
- `Default bank, never enrolled: 225 runs, 0 named, 223 INCONCLUSIVE, 2 UNKNOWN_MODEL`
- `Pooled bank, never enrolled: 350 probes, 51 named, 0 several, 299 none, 0 stopped`

Then compare the per-corpus rows in `docs/evaluation.md` with every line of the spec's "Expected results on the current corpora", including the pooled rows for `4d34afe7…` and `bbd00932…`. **If any value differs, stop and report the difference; do not edit the docs to match.**

- [ ] **Step 5: Run the full suite**

Run: `./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit`
Expected: PASS, including `tests/evaluation-report.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add scripts/evaluate-banks.mjs tests/evaluation-report.test.ts docs/evaluation.json docs/evaluation.md package.json
git commit -m "feat: add bank:evaluate and commit the report for the 0.7.0 banks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Documentation and release checks

**Files:**
- Modify: `README.md:85` and `README.md:91`, `docs/bank.md:64` and `docs/bank.md:277`, `docs/methodology.md:21`, `docs/bank-maintenance.md` (end), `CHANGELOG.md` (top)

**Interfaces:**
- Consumes: `docs/evaluation.md` and `docs/evaluation.json` from Task 4.

- [ ] **Step 1: Apply the spec's "Documentation changes" verbatim**

Make each replacement and insertion exactly as the spec words it, in the file and position it names. Each number must equal the generated report.

- [ ] **Step 2: Check the links and that no stale claim remains**

Run: `grep -n "There is no published independent\|have not been evaluated\|A local replay of 65" README.md docs/*.md`
Expected: no output.

Run: `grep -n "evaluation.md" README.md docs/bank.md docs/methodology.md docs/bank-maintenance.md`
Expected: at least one hit in each file. `docs/bank-maintenance.md` has the heading `## Evaluate the bundled banks`, which the rendered report links to as `#evaluate-the-bundled-banks`.

- [ ] **Step 3: Full checks**

Run: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run && npm run build && node scripts/package-smoke.mjs`
Expected: all pass. The package smoke test installs the tarball, which now also contains `docs/evaluation.json` and `docs/evaluation.md`.

- [ ] **Step 4: Scan the branch for local paths**

Run: `git diff main --name-only && git diff main -- . ':!specs' | grep -nE '/Users/|/private/|/home/|scratchpad' ; git log main..HEAD --format=%B | grep -nE '/Users/|/private/|scratchpad'`
Expected: the file list contains only the files named in this plan, and both greps print nothing. `specs/` is excluded because this plan's own constraint and scan command contain the search terms. It holds no actual path, which `grep -nE '/Use[r]s/[a-z]|/priva[t]e/tmp' specs/2026-11-21-*.md` (no output) confirms.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/bank.md docs/methodology.md docs/bank-maintenance.md CHANGELOG.md
git commit -m "docs: report the independent evaluation and how rarely envelopes reject" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
