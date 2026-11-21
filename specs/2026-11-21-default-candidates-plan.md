# Candidate Lists for Single-Request Probes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Single-request probes report `candidates`, the enrolled models the sequential test cannot rule out, most likely first. The evaluation report measures them, and the docs say what they mean and what they don't.

**Architecture:** `SequentialTest.snapshot()` additionally exposes each hypothesis's summed log likelihood. The engine's `classify()` derives the candidate list from those values and the per-model envelope verdicts it already computes. Statuses and the naming rule are untouched. The evaluation module counts the new lists, the report moves to schema version 2, and it is regenerated from the stored corpora.

**Tech Stack:** TypeScript ESM on Node ≥ 22, vitest. No new dependencies.

**Spec:** `specs/2026-11-21-default-candidates-design.md`

**Branch:** `feat/default-candidates`, created from `main` at `a4c07d3`.

## Global Constraints

- Statuses, models, confidences and reasons of every existing result must stay exactly as they are. After regeneration, `docs/evaluation.md` must show the same status counts as before.
- The candidate rule, its order (most likely first, ties in bank order), and the cases that omit `candidates` are exactly as the spec states them.
- Pooled `candidates` keep bank order.
- No provider requests.
- The repository is public under a pseudonymous identity: no absolute paths, local username or scratchpad paths in commits, specs or docs.
- In the maintainer's shell, `npm` may be the Socket wrapper. Verify with `./node_modules/.bin/tsc --noEmit` and `./node_modules/.bin/vitest run`, build with `npm run build`, and run scripts with `node`.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Equal likelihoods must keep bank order, so output is deterministic (Task 1 test `keeps bank order between equally likely candidates`).
2. A cross-transport result relabelled `HEURISTIC_MATCH` must keep its candidates (Task 1 assertion in the existing cross-transport test).
3. An early-stopped `IDENTIFIED` result must list only the named model (Task 1 assertion in `aborts at the first jointly accepted calibrated checkpoint`).
4. A bank with one calibrated model, and a short response, must not report `candidates` at all (Task 1 assertions).
5. Regenerating the evaluation must not change one status count (Task 2 step 5).

---

### Task 1: Candidates in the default engine

**Files:**
- Modify: `src/math/sprt.ts` (`SequentialDecision`, `snapshot()`), `src/core/engine.ts` (`classify()` and the result assembly), `src/core/types.ts` (the `candidates` comment)
- Test: `tests/math.test.ts`, `tests/engine.test.ts`, `tests/cli.test.ts`, `tests/fixtures.ts` (new fixture)

**Interfaces:**
- Produces:
  - `SequentialDecision.logLikelihoods: Record<string, number>`: each hypothesis id → its summed log likelihood so far.
  - `Classification` gains `candidates?: string[]`.
    - It is set to the rule's list whenever `classify()` has a sequential test and at least one envelope accepts.
    - It is set to `[]` for `UNKNOWN_MODEL` when there is a sequential test.
    - It is left unset on every other path.
  - `fingerprint()` copies the classification's `candidates` into the single-request result when it is set, including through `relabel()`.
  - `ProbeResult.candidates` comment: `Pooled banks: the prediction set, in bank order. Single-request banks: enrolled models the sequential test cannot reject against the most likely one and whose envelope accepts, most likely first.`
  - `tests/fixtures.ts`: `overlappingBank(): FingerprintBank`, with open envelopes.
    - `targetSamples` 128, checkpoints `[64, 128]`, transport `openai`.
    - Models in bank order:
      - `model-b`, family `synthetic-b`: 3 training and 2 validation runs of 63 × 10 then 65 × 30;
      - `model-a`, family `synthetic-a`: the same run counts of 64 × 10 then 64 × 20;
      - `model-c`, family `synthetic-c`: runs of 128 × 300.
    - A probe of 128 × 10 then leads `model-b` by 128 · ln(192.5 / 189.5) ≈ 2.0, below ln 400 ≈ 5.99, and `model-c` by far more.

- [ ] **Step 1: Write the failing tests**

- `tests/math.test.ts`, `reports each hypothesis's summed log likelihood`:
  - hypotheses `a` = `[0.75, 0.25]` and `b` = `[0.25, 0.75]`, then `update(0)`, `update(0)`, `update(1)`;
  - `snapshot().logLikelihoods.a` is close to `2 * Math.log(0.75) + Math.log(0.25)`, and `.b` to `2 * Math.log(0.25) + Math.log(0.75)`.
- `tests/engine.test.ts`, in `classification pipeline`:
  - `lists the models the sequential test cannot reject, most likely first`: 128 × `'10 '` against `overlappingBank()` gives `status: 'INCONCLUSIVE'` and `candidates` `['model-a', 'model-b']`.
  - `keeps bank order between equally likely candidates`: 64 × `'17 '` then 64 × `'287 '` against `openEnvelopes(syntheticBank())` with `earlyStopping: false` gives `candidates` `['synthetic-17', 'synthetic-287']`.
- Add assertions to existing tests:
  - `aborts at the first jointly accepted calibrated checkpoint`: `expect(result.candidates).toEqual(['synthetic-17'])`.
  - `does not accept high closed-set confidence when OOD rejects it`: `expect(result.candidates).toEqual([])`.
  - `does not use a different sample-size threshold on short responses`: `expect(result).not.toHaveProperty('candidates')`.
  - `reports a single-model bank as unable to identify, keeping its OOD verdict`: `expect(result).not.toHaveProperty('candidates')`.
  - The cross-transport test that expects `status: 'HEURISTIC_MATCH', model: 'synthetic-17'`: `expect(result.candidates).toEqual(['synthetic-17'])`.
- `tests/cli.test.ts`, `prints the candidates of an inconclusive single-request probe`:
  - write `overlappingBank()` as JSON into `directory`;
  - mock `fetch` with `sse('10 '.repeat(128))` and stub `LOGITPING_API_KEY`;
  - run `main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--bank', <path>, '--no-tokenizer', '--no-interactive'])`;
  - `stdout` contains `Inconclusive, consistent with: model-a, model-b`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/math.test.ts tests/engine.test.ts tests/cli.test.ts`
Expected: FAIL. `logLikelihoods` and `candidates` are undefined, and the CLI prints `INCONCLUSIVE` instead of the consistent-with line.

- [ ] **Step 3: Implement**

- `snapshot()` adds `logLikelihoods` from its running scores.
- In `classify()`, after the envelope scores and the decision, the candidates are the calibrated models with `decision.logLikelihoods[winner] − decision.logLikelihoods[id] < decision.threshold` and `score.accepted`. Sort them by log likelihood, highest first; `Array.prototype.sort` is stable, which keeps bank order for ties.
- Attach the list to the returned `IDENTIFIED` and `INCONCLUSIVE` classifications, and `[]` to `UNKNOWN_MODEL` when a sequential test exists.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit`
Expected: PASS, the whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/math/sprt.ts src/core/engine.ts src/core/types.ts tests/math.test.ts tests/engine.test.ts tests/cli.test.ts tests/fixtures.ts specs/2026-11-21-default-candidates-design.md specs/2026-11-21-default-candidates-plan.md
git commit -m "feat: list the candidates of single-request probes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Candidate metrics in the evaluation report

**Files:**
- Modify: `src/data/evaluation.ts` (tallies, scoring, rendering), `docs/evaluation.json` and `docs/evaluation.md` (regenerated)
- Test: `tests/evaluation.test.ts`

**Interfaces:**
- Consumes: `ProbeResult.candidates` from Task 1; each bank model's `family`.
- Produces:
  - `StatusTally` gains `listed`, `empty`, `candidateCount` and `multiVendor`. For each scored run:
    - `listed` counts it when the tested id is a candidate;
    - `empty` counts an empty or absent list;
    - `candidateCount` adds the list length;
    - `multiVendor` counts it when the candidates' families, taken from the bank that scored the run, number more than one.
  - `SetTally` gains `listed`.
  - `EvaluationReport.schemaVersion` becomes `2`.
  - Rendered columns, appended after the existing ones:
    - default enrolled: `Listed | Mean candidates | Several vendors`;
    - tested model removed, and models the bank does not enroll: `No candidate | Mean candidates | Several vendors`;
    - pooled enrolled: `Listed`.
  - `Mean candidates` is `candidateCount / runs` with one decimal, the total row included.
  - The intro paragraph gains: `Candidates are the enrolled models the engine cannot rule out; "Listed" counts runs or probes whose candidates include the tested model, and "Several vendors" those whose candidates span more than one model family.`

- [ ] **Step 1: Update and add the failing tests** in `tests/evaluation.test.ts`

- `tally()` and `sets()` defaults gain the new fields at `0`.
- Default-bank expectations:
  - full bank:
    - `synthetic-17`: `tally({ runs: 2, correct: 2, listed: 2, candidateCount: 2 })`;
    - mislabeled `synthetic-150`: `tally({ runs: 2, wrong: { 'synthetic-17': 2 }, candidateCount: 2 })`;
  - tested model removed: `synthetic-17` gives `tally({ runs: 2, unknown: 2, empty: 2 })`, and `synthetic-150` stays as named, with `candidateCount: 2`;
  - never enrolled: `{ runs: 5, unknown: 5, empty: 5 }` and `{ runs: 2, unknown: 2, empty: 2 }`;
  - mixed-role test: `tally({ runs: 5, correct: 5, listed: 5, candidateCount: 5 })` and `tally({ runs: 5, unknown: 5, empty: 5 })`.
- New `counts candidate lists that span several vendors`: `evaluateDefaultBank(overlappingBank(), [<digest of a corpus whose model 'model-a' has two runs of 128 × 10>])` gives `enrolled[0].models['model-a']` equal to `tally({ runs: 2, inconclusive: 2, listed: 2, candidateCount: 4, multiVendor: 2 })`.
- Pooled expectations:
  - correct case: `sets({ probes: 4, correct: 4, listed: 4 })`;
  - several case: `sets({ probes: 4, several: 4, listed: 4 })`;
  - the others stay unchanged.
- Rendered report literal:
  - `schemaVersion: 2`;
  - enrolled `m1` gains `listed: 2, empty: 0, candidateCount: 5, multiVendor: 1`, and its row and total become `| `cccccccccccc` | m1 | 3 | 1 | 2 (m2 1, m3 1) | 1 | 0 | 2 | 1.7 | 1 |` and `| **Total** | | 3 | 1 | 2 (m2 1, m3 1) | 1 | 0 | 2 | 1.7 | 1 |`;
  - label-removed `m1` gains `listed: 0, empty: 1, candidateCount: 4, multiVendor: 0`, and its row becomes `| `cccccccccccc` | m1 | 3 | 2 (m2 2) | 0 | 1 | 1 | 1.3 | 0 |`;
  - pooled `m9` gains `listed: 0`, and its row is unchanged.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/evaluation.test.ts`
Expected: FAIL on the new fields, columns and schema version.

- [ ] **Step 3: Implement** the tallies, the family lookup (from the bank that scored the run), the schema version and the columns.

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `./node_modules/.bin/vitest run tests/evaluation.test.ts && ./node_modules/.bin/tsc --noEmit`
Expected: PASS. `tests/evaluation-report.test.ts` now fails until the report is regenerated.

- [ ] **Step 5: Regenerate the report and check it**

Run: `npm run build && node scripts/evaluate-banks.mjs`

Expected: the five printed status lines are identical to the committed report's:
- `Default bank, enrolled: 460 runs, 152 correct, 0 wrong, 303 INCONCLUSIVE, 5 UNKNOWN_MODEL`
- `Default bank, tested model removed: 460 runs, 18 named, 413 INCONCLUSIVE, 29 UNKNOWN_MODEL`
- `Default bank, not enrolled: 225 runs, 0 named, 223 INCONCLUSIVE, 2 UNKNOWN_MODEL`
- `Pooled bank, enrolled: 300 probes, 116 correct, 42 wrong, 103 several, 39 none, 0 stopped`
- `Pooled bank, not enrolled: 350 probes, 51 named, 0 several, 299 none, 0 stopped`

In `docs/evaluation.md`:
- the enrolled total row ends `| 432 | 3.6 | 191 |`;
- the never-enrolled total row ends `| 3 | 6.5 | 191 |`.

**If any of these differ, stop and report; do not edit to match.**

- [ ] **Step 6: Run the full suite**

Run: `./node_modules/.bin/vitest run && ./node_modules/.bin/tsc --noEmit`
Expected: PASS, including `tests/evaluation-report.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/data/evaluation.ts tests/evaluation.test.ts docs/evaluation.json docs/evaluation.md
git commit -m "feat: measure candidate lists in the evaluation report" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Documentation and release checks

**Files:**
- Modify: `README.md`, `docs/methodology.md`, `docs/cli.md`, `docs/bank.md`, `CHANGELOG.md`

- [ ] **Step 1: Apply the spec's "Documentation changes" verbatim.** Each number must equal the regenerated report.

- [ ] **Step 2: Check the docs**

Run: `grep -n "with \`--pooled\`, \`candidates\` lists" README.md`
Expected: no output.

Run: `grep -c "candidates" README.md docs/methodology.md docs/cli.md docs/bank.md CHANGELOG.md`
Expected: at least 1 in each file.

- [ ] **Step 3: Full checks**

Run: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run && npm run build && node scripts/package-smoke.mjs`
Expected: all pass.

- [ ] **Step 4: Scan the branch for local paths**

Run: `git diff main --name-only && git diff main -- . ':!specs' | grep -nE '/Use[r]s/[A-Za-z]|/priva[t]e/tmp|scratchpad' ; git log main..HEAD --format=%B | grep -nE '/Use[r]s/|/priva[t]e/|scratchpad' ; grep -nE '/Use[r]s/[a-z]|/priva[t]e/tmp' specs/2026-11-21-default-candidates-*.md`
Expected: only files named in this plan, and the three greps print nothing.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/methodology.md docs/cli.md docs/bank.md CHANGELOG.md
git commit -m "docs: describe candidate lists for single-request probes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
