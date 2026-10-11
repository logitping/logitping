# Pooled Short-Request Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in experimental probe mode. It sends 8 requests of 64 integers, pools them into a conformal prediction set, and applies each model's per-response OOD envelope in front of the set. It ships with a bundled pooled bank. The default probe and bank are unchanged.

**Architecture:**
- **Math.** Two pure modules hold the frozen feature groups (`src/math/pooled_features.ts`) and the prediction-set statistics (`src/math/pooled_sets.ts`).
- **Enrollment.** `src/data/pooled_enrollment.ts` extends a v1 bank into a schema-v2 bank. It adds smoothed distributions, pair statistics and bootstrap cutoffs fitted once with a seeded, cross-fitted bootstrap.
- **Engine.** The engine reads `requestsPerProbe` from the bank. For pooled banks it sends the requests sequentially, each under a child abort scope, then classifies with `src/core/pooled.ts`.
- **Surface.** The CLI adds `--pooled`, and the library adds `pooledBank()` and `createPooledBank()`.

**Tech Stack:** TypeScript (strict, ESM), Node ≥ 22, vitest, tsup/esbuild, commander, @clack/prompts.

**Spec:** `specs/2026-10-11-pooled-probe-design.md`. Read it before starting. It holds the evidence, the decisions and the exact statistics.

## Global Constraints

- **Default path unchanged.** Do not modify `src/data/default_bank.json` or the default (v1, single-request) probe path. Every existing test must still pass unchanged, except the fixture edits named in Task 1.
- **Frozen statistics.**
  - `pooled-sets-v1` feature groups are frozen as the spec table defines them.
  - α = 0.2, bootstrap draws = 2000, default seed = 20261011.
  - cutoff = `sorted[floor((α/2)·(draws+1)) − 1]`, and a model is kept iff score ≥ cutoff.
- **Pooled bank format.**
  - `schemaVersion: 2`.
  - `protocol.id: 'integer-v1'`.
  - `protocol.requestsPerProbe`: an integer from 2 to 64.
  - `protocol.scoring: 'pooled-sets-v1'`.
- **Statuses.**
  - One candidate gives `HEURISTIC_MATCH`, with exit code 2 and `confidence: null`.
  - Two or more candidates give `INCONCLUSIVE`.
  - None gives `UNKNOWN_MODEL`.
- **Pooled mode behavior.** Probes are never retried, and pooled mode never stops early.
- **No paid requests.** Make no provider requests (OpenRouter or any other) without the user's explicit approval.
- **TypeScript settings.** `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on. Use `!` on indexed reads, as the codebase does.
- **Commands.**
  - Tests: `./node_modules/.bin/vitest run`.
  - Typecheck: `./node_modules/.bin/tsc --noEmit`.
  - npm scripts: `node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run <script>`. The shell's `npm` is a Socket wrapper that breaks some flags and JSON output.
- **Commits.** Work on branch `pooled-probe`. Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Code style.**
  - Match the surrounding code: short doc comments on exported functions, comments only where they explain why, and no new dependencies.
- **Research files.** The research scripts live in the session scratchpad, `<scratchpad>/`. Task 1 copies them into the repo before anything else, because the scratchpad does not outlive the session.
- **Git-ignored corpora** at the repo root, used by Tasks 8 and 10:
  - `research-64.local.json`: the v1 bank fitted from the 64-integer collection.
  - `research-64.local.json.corpus-4d34afe7497e9d0d83238136885022a808a5c0e6ecfcfc32b7ed5689131f0bbf.json`.

## Review Focus

Each line below names an input or failure that is easy to miss, and the test that pins it.

1. **Truncated first request.** A reasoning model under the default 384-token budget truncates request 1. Expect `INCONCLUSIVE` naming request 1 and the token limit, with no further requests. Pinned by Task 6, "stops at a short reply and names the request".
2. **Interruption between requests.** Ctrl+C or the deadline fires between requests. Expect no further requests and the `Interrupted` or `TimeoutError` rejection. Pinned by Task 6, the deadline and cancellation tests.
3. **Malformed custom pooled bank.** The bank has one model or an uncalibrated model. Expect `INVALID_BANK` before any request. Pinned by Task 4, the validation rejection cases.
4. **`--pooled` against a mismatched protocol.** `--pooled` combined with `--samples 512`, or with a CLI driver, gives `PROTOCOL_MISMATCH` before any request. Pinned by Task 9, "checks the pooled bank protocol before any request".
5. **A bank from a different version.** A pooled bank under schema version 1, or a schema-3 bank, is rejected and never probed. Pinned by Task 4, the "pooled scoring under schema version 1" and "unknown schema version" cases.

---

### Task 1: Commit the loop check and keep the research scripts

The loop check, piece 1 of the design, is implemented and tested but uncommitted on this branch. Commit it first. Then copy the research scripts out of the session scratchpad.

**Files:**
- Commit (already modified): `src/data/repetition.ts`, `src/data/gateway_update.ts`, `tests/gateway-update.test.ts`, `docs/bank-maintenance.md`, `CHANGELOG.md`
- Create: `scripts/research/prototype.mjs`, `scripts/research/prototype-eval.mjs`, `scripts/research/gate-test.mjs`, `scripts/research/README.md`

**Interfaces:**
- Produces: `findRepeatingCycle(samples: readonly number[]): { period: number; share: number } | undefined` from `src/data/repetition.ts`, already present.

- [ ] **Step 1: Confirm the working tree passes**

Run: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run`
Expected: typecheck passes, and the run reports `Tests  477 passed (477)`.

- [ ] **Step 2: Commit the loop check**

```bash
git add src/data/repetition.ts src/data/gateway_update.ts tests/gateway-update.test.ts docs/bank-maintenance.md CHANGELOG.md
git commit -m "feat: reject looping replies during bank collection

A reply whose retained integers repeat at some period of at most 128
integers and a quarter of the run, for at least 90% of positions, is
retried like invalid output and counted as invalid in provenance.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Copy the research scripts and make their imports relative**

```bash
S=<scratchpad>
mkdir -p scripts/research
cp "$S/prototype.mjs" "$S/prototype-eval.mjs" "$S/gate-test.mjs" scripts/research/
shasum -a 256 scripts/research/prototype.mjs
sed -i '' "s#'<repo>/dist/index.js'#'../../dist/index.js'#" scripts/research/prototype.mjs scripts/research/prototype-eval.mjs scripts/research/gate-test.mjs
grep -n "dist/index.js" scripts/research/*.mjs
shasum -a 256 scripts/research/prototype.mjs
```

Expected:
- The first hash is `2964649026827d4774b2331b8a70c55b85a9eb3b2e4e7552166acdb40fffed24`.
- After the edit, each script has exactly one `'../../dist/index.js'` import.
- Note the second hash for the README.

- [ ] **Step 4: Confirm the gate test still reproduces at k = 8**

Run:

```bash
KS=8 node scripts/research/gate-test.mjs research-64.local.json.corpus-4d34afe7497e9d0d83238136885022a808a5c0e6ecfcfc32b7ed5689131f0bbf.json | grep -e '^| 8 |'
```

Expected rows:
- `C4 all families, pairwise margin, cross-fitted; gated`: `1/65 (1.5%) ✗ | 9/65 (13.8%) ✗ | 6/10`, with correct singletons `45/65`.
- `Current engine, pooled SPRT + all-k OOD gate`: `0/65 (0.0%) | 24/65 (36.9%) ✗ | 3/10 ✗`.

- [ ] **Step 5: Write `scripts/research/README.md`**

Replace `<second hash>` with the hash printed in Step 3.

```markdown
# Pooled-probe research scripts

Offline scripts behind `specs/2026-10-11-pooled-probe-design.md`. They read local corpora only and make no provider requests. Build first (`npm run build`), because they import `../../dist/index.js`.

| Script | Purpose |
|---|---|
| `prototype.mjs` | The prototype frozen before the 2026-10-11 collection: conformal prediction sets C1–C5 over seven feature groups. |
| `prototype-eval.mjs` | `prototype.mjs` plus harness options: `KS` (requests per unit), `DROP_LOOPS`, and the unenrolled (leave-one-model-out) refit. |
| `gate-test.mjs` | Exploratory follow-up: C1 and C4 with each model's per-response OOD envelope in front of the set, against the current engine pooled over the same requests. |
| `check-pooled.mjs` | Checks the production implementation against the prototype; see Task 10 of the plan. |

`prototype.mjs` was frozen with SHA-256 `2964649026827d4774b2331b8a70c55b85a9eb3b2e4e7552166acdb40fffed24`. The only change since is its import line: an absolute local path became `'../../dist/index.js'`. Its SHA-256 is now `<second hash>`.

The corpora are git-ignored and stay at the repository root:

- `research-512.local.json.corpus-73559ea6….json`: 13 models × 40 runs × 512 integers.
- `research-64.local.json.corpus-4d34afe7….json`: 13 models × 40 runs × 64 integers.

Both were collected through OpenRouter on 2026-10-11.

Example: `KS=4,8 node scripts/research/gate-test.mjs research-64.local.json.corpus-4d34afe7497e9d0d83238136885022a808a5c0e6ecfcfc32b7ed5689131f0bbf.json`
```

- [ ] **Step 6: Commit**

```bash
git add scripts/research
git commit -m "chore: keep the pooled-probe research scripts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pooled feature groups

**Files:**
- Create: `src/math/pooled_features.ts`
- Test: `tests/pooled-math.test.ts`

**Interfaces:**
- Produces:
  - `POOLED_SCORING: 'pooled-sets-v1'`.
  - `FAMILY_SIZES: readonly [355, 355, 400, 100, 1420, 2840, 12]`.
  - `interface EventCounts { counts: Map<number, number>; total: number }`.
  - `countEvents(run: readonly number[]): EventCounts[]`: one entry per group. It throws `RangeError` for integers outside [1, 355].
  - `interface FamilyTotals { counts: Float64Array[]; totals: number[] }`.
  - `sumFamilies(runs: readonly (readonly EventCounts[])[]): FamilyTotals`.
  - `smoothFamilies(totals: FamilyTotals): number[][]`: Jeffreys-smoothed probabilities per group.
  - `logLikelihoods(run: readonly EventCounts[], totals: FamilyTotals, leaveOut?: readonly EventCounts[]): number[]`: per-group log-likelihood from counts, optionally with one of the model's own runs removed.
  - `familyLogLikelihoods(run: readonly EventCounts[], logProbabilities: readonly (readonly number[])[]): number[]`: the same quantity from stored log-probabilities.

- [ ] **Step 1: Write the failing tests**

Create `tests/pooled-math.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { countEvents, FAMILY_SIZES, familyLogLikelihoods, logLikelihoods, smoothFamilies, sumFamilies, type EventCounts } from '../src/math/pooled_features.js';

const entries = (group: EventCounts) => [...group.counts].sort(([a], [b]) => a - b);

describe('pooled feature groups', () => {
  it('counts the events of every group', () => {
    const groups = countEvents([1, 2, 355, 2, 20, 40, 1, 9, 9]);
    expect(groups.map((group) => group.total)).toEqual([9, 8, 8, 8, 6, 8, 9]);
    expect(entries(groups[0]!)).toEqual([[0, 2], [1, 2], [8, 2], [19, 1], [39, 1], [354, 1]]);
    expect(entries(groups[1]!)).toEqual([[0, 1], [1, 1], [2, 1], [8, 1], [18, 1], [20, 1], [316, 1], [353, 1]]);
    expect(entries(groups[2]!)).toEqual([[0, 3], [1, 1], [19, 1], [22, 1], [40, 1], [380, 1]]);
    expect(entries(groups[3]!)).toEqual([[0, 1], [1, 1], [12, 1], [19, 1], [20, 1], [25, 1], [52, 1], [99, 1]]);
    expect(entries(groups[4]!)).toEqual([[0, 1], [4, 1], [32, 1], [76, 1], [156, 1], [1416, 1]]);
    expect(entries(groups[5]!)).toEqual([[0, 1], [356, 1], [1064, 1], [1066, 1], [1439, 1], [1814, 1], [2130, 1], [2493, 1]]);
    expect(entries(groups[6]!)).toEqual([[0, 6], [1, 1], [2, 1], [3, 1]]);
  });

  it('places first uses by quarter of a 355-position run and bins values every 17.75', () => {
    const firstUse = countEvents(Array.from({ length: 100 }, (_, t) => t + 1))[4]!.counts;
    // Value 89 is first used at t = 88 (quarter 0); value 90 at t = 89 (quarter 1).
    expect(firstUse.has(88 * 4)).toBe(true);
    expect(firstUse.has(89 * 4 + 1)).toBe(true);
    expect(entries(countEvents([18, 19])[2]!)).toEqual([[1, 1]]);
  });

  it('caps repeat gaps at bin 11', () => {
    const run = [5, ...Array.from({ length: 2100 }, (_, t) => (t % 300) + 10), 5];
    expect(countEvents(run)[6]!.counts.get(11)).toBe(1);
  });

  it('rejects integers outside [1, 355]', () => {
    expect(() => countEvents([1, 356])).toThrow(RangeError);
    expect(() => countEvents([0, 1])).toThrow(RangeError);
  });

  it('smooths pooled counts into distributions of the group sizes', () => {
    const families = smoothFamilies(sumFamilies([countEvents([1, 1]), countEvents([2, 3])]));
    expect(families.map((family) => family.length)).toEqual([...FAMILY_SIZES]);
    for (const family of families) expect(family.reduce((sum, p) => sum + p, 0)).toBeCloseTo(1, 12);
    expect(families[0]![0]).toBeCloseTo(2.5 / (4 + 0.5 * 355), 15);
  });

  it('leaves a run out of its own model exactly', () => {
    const a = countEvents([3, 7, 7, 300, 12, 3]);
    const b = countEvents([4, 7, 8, 299, 12, 5]);
    const both = sumFamilies([a, b]);
    const left = logLikelihoods(a, both, a);
    const reference = logLikelihoods(a, sumFamilies([b]));
    left.forEach((value, group) => expect(value).toBeCloseTo(reference[group]!, 12));
    expect(logLikelihoods(a, both)).not.toEqual(left);
  });

  it('gives the same likelihood from stored probabilities as from counts', () => {
    const totals = sumFamilies([countEvents([3, 7, 7, 300]), countEvents([4, 7, 8, 299])]);
    const run = countEvents([7, 7, 12, 300]);
    const fromProbabilities = familyLogLikelihoods(run, smoothFamilies(totals).map((family) => family.map(Math.log)));
    logLikelihoods(run, totals).forEach((value, group) => expect(fromProbabilities[group]).toBeCloseTo(value, 9));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/pooled-math.test.ts`
Expected: FAIL with `Cannot find module '../src/math/pooled_features.js'`.

- [ ] **Step 3: Implement `src/math/pooled_features.ts`**

```ts
import { assertIntegerSample, INTEGER_MAX } from './ordered_block.js';

/** Scoring method of pooled banks; it fixes the feature groups below. */
export const POOLED_SCORING = 'pooled-sets-v1' as const;
/** Category counts of the seven feature groups, in order. */
export const FAMILY_SIZES = [INTEGER_MAX, INTEGER_MAX, 400, 100, INTEGER_MAX * 4, INTEGER_MAX * 8, 12] as const;
/** Jeffreys smoothing, as in the v1 bank. */
const SMOOTHING = 0.5;

/** Event counts of one run in one feature group. */
export interface EventCounts {
  counts: Map<number, number>;
  total: number;
}

/** Summed event counts of a model's runs, per group. */
export interface FamilyTotals {
  counts: Float64Array[];
  totals: number[];
}

const N = INTEGER_MAX;
/** Frozen as evaluated offline; changing any definition needs a new scoring id. */
const GROUPS: readonly ((run: readonly number[]) => number[])[] = [
  // Value.
  (run) => run.map((x) => x - 1),
  // Step between consecutive values, modulo 355.
  (run) => run.slice(1).map((x, t) => (x - run[t]! + N) % N),
  // Consecutive value bins: 20 bins of 17.75 values.
  (run) => run.slice(1).map((x, t) => Math.floor((run[t]! - 1) / 17.75) * 20 + Math.floor((x - 1) / 17.75)),
  // Consecutive last digits.
  (run) => run.slice(1).map((x, t) => (run[t]! % 10) * 10 + (x % 10)),
  // Each value's first use, by quarter of a 355-position run.
  (run) => {
    const seen = new Set<number>();
    const events: number[] = [];
    run.forEach((x, t) => {
      if (!seen.has(x)) { seen.add(x); events.push((x - 1) * 4 + Math.min(3, Math.floor(t / 89))); }
    });
    return events;
  },
  // Opening: the value at each of the first 8 positions.
  (run) => run.slice(0, 8).map((x, t) => t * N + x - 1),
  // Positions since the value last appeared, in log2 bins; 0 for a first occurrence.
  (run) => {
    const last = new Map<number, number>();
    return run.map((x, t) => {
      const previous = last.get(x);
      last.set(x, t);
      return previous === undefined ? 0 : Math.min(11, 1 + Math.floor(Math.log2(t - previous)));
    });
  },
];

/** Count each feature group's events in one run of integers in [1, 355]. */
export function countEvents(run: readonly number[]): EventCounts[] {
  for (const value of run) assertIntegerSample(value);
  return GROUPS.map((group) => {
    const counts = new Map<number, number>();
    const events = group(run);
    for (const event of events) counts.set(event, (counts.get(event) ?? 0) + 1);
    return { counts, total: events.length };
  });
}

export function sumFamilies(runs: readonly (readonly EventCounts[])[]): FamilyTotals {
  const counts = FAMILY_SIZES.map((size) => new Float64Array(size));
  const totals = FAMILY_SIZES.map(() => 0);
  for (const run of runs) {
    run.forEach(({ counts: events, total }, group) => {
      for (const [event, count] of events) counts[group]![event]! += count;
      totals[group]! += total;
    });
  }
  return { counts, totals };
}

/** Jeffreys-smoothed probabilities of each group. */
export function smoothFamilies(totals: FamilyTotals): number[][] {
  return FAMILY_SIZES.map((size, group) => Array.from(totals.counts[group]!, (count) => (count + SMOOTHING) / (totals.totals[group]! + SMOOTHING * size)));
}

/** Per-group log-likelihoods of `run` under smoothed `totals`, optionally with one of the model's own runs left out. */
export function logLikelihoods(run: readonly EventCounts[], totals: FamilyTotals, leaveOut?: readonly EventCounts[]): number[] {
  return run.map(({ counts }, group) => {
    const removed = leaveOut?.[group];
    const logDenominator = Math.log(totals.totals[group]! - (removed?.total ?? 0) + SMOOTHING * FAMILY_SIZES[group]!);
    let sum = 0;
    for (const [event, count] of counts) {
      sum += count * (Math.log(totals.counts[group]![event]! - (removed?.counts.get(event) ?? 0) + SMOOTHING) - logDenominator);
    }
    return sum;
  });
}

/** Per-group log-likelihoods of `run` under stored per-group log probabilities. */
export function familyLogLikelihoods(run: readonly EventCounts[], logProbabilities: readonly (readonly number[])[]): number[] {
  return run.map(({ counts }, group) => {
    let sum = 0;
    for (const [event, count] of counts) sum += count * logProbabilities[group]![event]!;
    return sum;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run tests/pooled-math.test.ts && ./node_modules/.bin/tsc --noEmit`
Expected: 7 tests pass, and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add src/math/pooled_features.ts tests/pooled-math.test.ts
git commit -m "feat: add the frozen pooled-sets-v1 feature groups

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Prediction-set statistics

**Files:**
- Create: `src/math/pooled_sets.ts`
- Test: `tests/pooled-math.test.ts` (append)

**Interfaces:**
- Produces:
  - `interface PairStatistic { weights: number[]; center: number; scale: number }`.
  - `fitPairStatistic(ownRuns: readonly (readonly number[])[], competitorRuns: readonly (readonly number[])[]): PairStatistic`. Each row is a run's per-group ratio, `LL(run | model) − LL(run | competitor)`.
  - `pairScore(statistic: PairStatistic, ratios: readonly number[]): number`.
  - `aggregateScores(fits: readonly number[], margins: readonly (readonly number[])[]): { fit: number; margin: number }`. Here `margins[response][competitor]`.
  - `cutoffIndex(alpha: number, draws: number): number`.
  - `mulberry32(seed: number): () => number`.

- [ ] **Step 1: Append the failing tests to `tests/pooled-math.test.ts`**

Add this import at the top:

```ts
import { aggregateScores, cutoffIndex, fitPairStatistic, mulberry32, pairScore } from '../src/math/pooled_sets.js';
```

Append:

```ts
describe('pooled prediction-set statistics', () => {
  it('fits clipped diagonal-LDA weights and standardizes the combined score', () => {
    const statistic = fitPairStatistic([[2, 0], [4, 0]], [[0, 1], [0, 3]]);
    expect(statistic).toEqual({ weights: [3, 0], center: 4.5, scale: 3 });
    expect(pairScore(statistic, [4, 0])).toBe(2.5);
  });

  it('falls back to equal weights and a minimum scale', () => {
    expect(fitPairStatistic([[0], [1]], [[2], [3]]).weights).toEqual([1]);
    expect(fitPairStatistic([[1], [1]], [[1], [1]])).toEqual({ weights: [1], center: 1, scale: 1e-6 });
  });

  it('sums fits and divides the worst competitor margin by sqrt(k)', () => {
    expect(aggregateScores([1, 2, 3, 4], [[1, 5], [1, 5], [1, 5], [1, 5]])).toEqual({ fit: 10, margin: 2 });
  });

  it.each([[2000, 199], [99, 9], [199, 19]])('keeps score >= cutoff exactly when the conformal p-value exceeds alpha/2 (draws=%i)', (draws, index) => {
    expect(cutoffIndex(0.2, draws)).toBe(index);
    const random = mulberry32(draws);
    // Integer nulls and half-step scores exercise ties.
    const nulls = Array.from({ length: draws }, () => Math.round(random() * 50));
    const sorted = [...nulls].sort((a, b) => a - b);
    for (let score = -1; score <= 51; score += 0.5) {
      const p = (1 + nulls.filter((value) => value <= score).length) / (draws + 1);
      expect(score >= sorted[index]!).toBe(p > 0.1);
    }
  });

  it('generates the prototype bootstrap sequence', () => {
    const random = mulberry32(20261011);
    expect([random(), random()]).toEqual([0.34649015543982387, 0.8141545492690057]);
    const values = Array.from({ length: 1000 }, mulberry32(7));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/pooled-math.test.ts`
Expected: FAIL with `Cannot find module '../src/math/pooled_sets.js'`.

- [ ] **Step 3: Implement `src/math/pooled_sets.ts`**

```ts
/** Standardized head-to-head score of a model against one competitor; positive favors the model. */
export interface PairStatistic {
  weights: number[];
  center: number;
  scale: number;
}

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
/** Pooled within-class variance, as in the prototype. */
const pooledVariance = (a: readonly number[], b: readonly number[], ma: number, mb: number) =>
  (a.reduce((sum, x) => sum + (x - ma) ** 2, 0) + b.reduce((sum, x) => sum + (x - mb) ** 2, 0)) / (a.length + b.length - 2);

/**
 * Diagonal-LDA weights over per-group log-likelihood ratios, clipped at zero, then standardized on
 * the same runs. Rows hold LL(run | model) − LL(run | competitor) for each group.
 */
export function fitPairStatistic(ownRuns: readonly (readonly number[])[], competitorRuns: readonly (readonly number[])[]): PairStatistic {
  const weights = ownRuns[0]!.map((_, group) => {
    const a = ownRuns.map((row) => row[group]!);
    const b = competitorRuns.map((row) => row[group]!);
    const ma = mean(a);
    const mb = mean(b);
    const variance = pooledVariance(a, b, ma, mb);
    return variance > 0 && ma > mb ? (ma - mb) / variance : 0;
  });
  if (weights.every((weight) => weight === 0)) weights.fill(1);
  const combine = (row: readonly number[]) => row.reduce((sum, x, group) => sum + weights[group]! * x, 0);
  const da = ownRuns.map(combine);
  const db = competitorRuns.map(combine);
  const ma = mean(da);
  const mb = mean(db);
  return { weights, center: (ma + mb) / 2, scale: Math.sqrt(Math.max(pooledVariance(da, db, ma, mb), 1e-12)) };
}

export function pairScore(statistic: PairStatistic, ratios: readonly number[]): number {
  return (ratios.reduce((sum, x, group) => sum + statistic.weights[group]! * x, 0) - statistic.center) / statistic.scale;
}

/** Combine k responses: the summed fit, and the worst competitor's summed margin divided by sqrt(k). */
export function aggregateScores(fits: readonly number[], margins: readonly (readonly number[])[]): { fit: number; margin: number } {
  const fit = fits.reduce((sum, value) => sum + value, 0);
  let margin = Infinity;
  for (let competitor = 0; competitor < margins[0]!.length; competitor++) {
    const total = margins.reduce((sum, row) => sum + row[competitor]!, 0) / Math.sqrt(fits.length);
    if (total < margin) margin = total;
  }
  return { fit, margin };
}

/**
 * Index into ascending null scores such that `score >= sorted[index]` holds exactly when the
 * conformal p-value (1 + #{null <= score}) / (draws + 1) exceeds alpha / 2.
 */
export function cutoffIndex(alpha: number, draws: number): number {
  return Math.floor((alpha / 2) * (draws + 1)) - 1;
}

/** Small deterministic generator for the enrollment bootstrap, as in the prototype. */
export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/vitest run tests/pooled-math.test.ts && ./node_modules/.bin/tsc --noEmit`
Expected: 14 tests pass (7 + 7, counting the 3 `it.each` rows), and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add src/math/pooled_sets.ts tests/pooled-math.test.ts
git commit -m "feat: add pooled prediction-set statistics

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Bank schema version 2 types and validation

**Files:**
- Modify: `src/core/types.ts` (`FingerprintBank`, `ModelScore`, `ProbeResult`)
- Modify: `src/data/bank_loader.ts` (`validateBank`)
- Modify: `tests/fixtures.ts` (add `uniformPooledBank`)
- Test: `tests/pooled-bank.test.ts` (create)

**Interfaces:**
- Consumes: `POOLED_SCORING` and `FAMILY_SIZES` (Task 2), `PairStatistic` (Task 3).
- Produces:
  - `interface PooledScoring { alpha: number; bootstrap: { draws: number; seed: number }; models: { families: number[][]; cutoffs: { fit: number; margin: number } }[]; pairs: ({ model: string; competitor: string } & PairStatistic)[] }`.
  - `FingerprintBank` changes:
    - `schemaVersion: 1 | 2`;
    - `protocol.requestsPerProbe?: number`;
    - `protocol.scoring?: 'pooled-sets-v1'`;
    - `pooled?: PooledScoring`.
  - `ModelScore` gains `fit?`, `margin?`, `fitCutoff?` and `marginCutoff?`, all `number`.
  - `ProbeResult` gains `candidates?: string[]` and `requests?: number`.
  - Fixture `uniformPooledBank(requestsPerProbe = 4): FingerprintBank`.

- [ ] **Step 1: Add the fixture to `tests/fixtures.ts`**

Add these imports:

```ts
import { FAMILY_SIZES } from '../src/math/pooled_features.js';
```

Append:

```ts
/** A schema-v2 bank with a uniform pooled section, for validation tests that need no real calibration. */
export function uniformPooledBank(requestsPerProbe = 4): FingerprintBank {
  const bank = syntheticBank();
  bank.schemaVersion = 2;
  bank.protocol.requestsPerProbe = requestsPerProbe;
  bank.protocol.scoring = 'pooled-sets-v1';
  bank.pooled = {
    alpha: 0.2, bootstrap: { draws: 2000, seed: 1 },
    models: bank.models.map(() => ({ families: FAMILY_SIZES.map((size) => Array<number>(size).fill(1 / size)), cutoffs: { fit: 0, margin: 0 } })),
    pairs: bank.models.flatMap((model) => bank.models.filter((other) => other !== model)
      .map((other) => ({ model: model.id, competitor: other.id, weights: Array<number>(FAMILY_SIZES.length).fill(1), center: 0, scale: 1 }))),
  };
  return bank;
}
```

- [ ] **Step 2: Write the failing tests in `tests/pooled-bank.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import type { FingerprintBank } from '../src/core/types.js';
import { validateBank } from '../src/data/bank_loader.js';
import { uniformPooledBank } from './fixtures.js';

function thrown(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  return undefined;
}

describe('pooled bank validation', () => {
  it('accepts a schema-v2 bank and returns an independent copy', () => {
    const bank = uniformPooledBank();
    const copy = validateBank(bank);
    expect(copy).toEqual(bank);
    copy.pooled!.models[0]!.cutoffs.fit = 5;
    expect(bank.pooled!.models[0]!.cutoffs.fit).toBe(0);
  });

  it.each<[string, (bank: FingerprintBank) => void]>([
    ['schema version 2 without a pooled section', (bank) => { delete bank.pooled; }],
    ['pooled scoring under schema version 1', (bank) => { bank.schemaVersion = 1; }],
    ['an unknown schema version', (bank) => { (bank as { schemaVersion: number }).schemaVersion = 3; }],
    ['a missing scoring id', (bank) => { delete bank.protocol.scoring; }],
    ['one request per probe', (bank) => { bank.protocol.requestsPerProbe = 1; }],
    ['65 requests per probe', (bank) => { bank.protocol.requestsPerProbe = 65; }],
    ['a single model', (bank) => { bank.models.pop(); bank.pooled!.models.pop(); bank.pooled!.pairs = []; }],
    ['an uncalibrated model', (bank) => { bank.models[1]!.status = 'uncalibrated'; }],
    ['a feature group of the wrong size', (bank) => { bank.pooled!.models[0]!.families[2]!.pop(); }],
    ['an unsmoothed probability', (bank) => { const family = bank.pooled!.models[0]!.families[0]!; family[1]! += family[0]!; family[0] = 0; }],
    ['a non-finite cutoff', (bank) => { bank.pooled!.models[0]!.cutoffs.fit = Infinity; }],
    ['a missing pooled model', (bank) => { bank.pooled!.models.pop(); }],
    ['a missing pair', (bank) => { bank.pooled!.pairs.pop(); }],
    ['a duplicate pair', (bank) => { bank.pooled!.pairs[1] = structuredClone(bank.pooled!.pairs[0]!); }],
    ['a model paired with itself', (bank) => { bank.pooled!.pairs[0]!.competitor = bank.pooled!.pairs[0]!.model; }],
    ['a negative weight', (bank) => { bank.pooled!.pairs[0]!.weights[0] = -1; }],
    ['a zero scale', (bank) => { bank.pooled!.pairs[0]!.scale = 0; }],
  ])('rejects %s', (_name, mutate) => {
    const bank = uniformPooledBank();
    mutate(bank);
    expect(thrown(() => validateBank(bank))).toMatchObject({ code: 'INVALID_BANK' });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/pooled-bank.test.ts`
Expected: FAIL. The TypeScript types reject `requestsPerProbe` and `pooled`, or, if transpiled without typechecking, validation rejects `schemaVersion: 2`.

- [ ] **Step 4: Extend the types in `src/core/types.ts`**

Add imports at the top:

```ts
import type { POOLED_SCORING } from '../math/pooled_features.js';
import type { PairStatistic } from '../math/pooled_sets.js';
```

Add, above `export interface FingerprintBank`:

```ts
/** Prediction-set calibration of a pooled bank (schema version 2); see docs/methodology.md. */
export interface PooledScoring {
  alpha: number;
  bootstrap: { draws: number; seed: number };
  /** In the order of `FingerprintBank.models`. */
  models: { families: number[][]; cutoffs: { fit: number; margin: number } }[];
  pairs: ({ model: string; competitor: string } & PairStatistic)[];
}
```

In `FingerprintBank`, make these changes:
- Replace `schemaVersion: 1;` with `schemaVersion: 1 | 2;`.
- Add inside `protocol`, after `transport`:

```ts
    /** Pooled banks (schema version 2): requests per probe, each of `targetSamples` integers. */
    requestsPerProbe?: number;
    scoring?: typeof POOLED_SCORING;
```

- Add after `calibration`:

```ts
  /** Present exactly when `schemaVersion` is 2. */
  pooled?: PooledScoring;
```

In `ModelScore`, add after `weight`:

```ts
  /** Pooled banks only: summed fit and worst head-to-head margin over all responses, with this model's cutoffs. */
  fit?: number;
  margin?: number;
  fitCutoff?: number;
  marginCutoff?: number;
```

In `ProbeResult`, add after `crossTransport?`:

```ts
  /** Pooled banks only, once every request completed: the prediction set, in bank order. */
  candidates?: string[];
  /** Pooled banks only: requests sent for this probe. */
  requests?: number;
```

- [ ] **Step 5: Validate schema version 2 in `src/data/bank_loader.ts`**

Add imports:

```ts
import { FAMILY_SIZES, POOLED_SCORING } from '../math/pooled_features.js';
```

Replace:

```ts
  check(bank.schemaVersion === 1 && bank.featureVersion === FEATURE_VERSION && bank.alpha === 0.5, 'unsupported schema, features, or smoothing');
```

with:

```ts
  check((bank.schemaVersion === 1 || bank.schemaVersion === 2) && bank.featureVersion === FEATURE_VERSION && bank.alpha === 0.5, 'unsupported schema, features, or smoothing');
```

Insert before the final `return structuredClone(input) as FingerprintBank;`:

```ts
  // A version-1 reader rejects version 2, so a pooled bank is never probed with a single request.
  if (bank.schemaVersion === 2) validatePooled(bank, protocol, bank.models as Record<string, unknown>[]);
  else check(protocol.requestsPerProbe === undefined && protocol.scoring === undefined && bank.pooled === undefined, 'pooled scoring requires schemaVersion 2');
```

Add above `validateBank`:

```ts
function validatePooled(bank: Record<string, unknown>, protocol: Record<string, unknown>, models: Record<string, unknown>[]): void {
  check(protocol.scoring === POOLED_SCORING, `protocol.scoring must be ${POOLED_SCORING}`);
  check(integer(protocol.requestsPerProbe, 2, 64), 'requestsPerProbe must be an integer from 2 to 64');
  check((protocol.targetSamples as number) * protocol.requestsPerProbe <= MAX_SAMPLES, `targetSamples × requestsPerProbe must be at most ${MAX_SAMPLES}`);
  check(models.length >= 2 && models.every((model) => model.status === 'calibrated'), 'pooled banks need at least two calibrated models');
  const pooled = object(bank.pooled, 'pooled');
  check(typeof pooled.alpha === 'number' && pooled.alpha > 0 && pooled.alpha < 1, 'pooled alpha');
  const bootstrap = object(pooled.bootstrap, 'pooled.bootstrap');
  check(integer(bootstrap.draws, 100, 100_000) && integer(bootstrap.seed, 0, 0xffffffff), 'pooled bootstrap');
  check(Array.isArray(pooled.models) && pooled.models.length === models.length, 'pooled.models must match models');
  for (const value of pooled.models) {
    const entry = object(value, 'pooled model');
    check(Array.isArray(entry.families) && entry.families.length === FAMILY_SIZES.length, 'pooled feature groups');
    entry.families.forEach((family: unknown, group: number) => {
      vector(family, FAMILY_SIZES[group]!, 'pooled feature group dimensions');
      distribution(family, 'pooled feature group');
      check(family.every((p) => p > 0), 'pooled probabilities must be smoothed');
    });
    const cutoffs = object(entry.cutoffs, 'pooled cutoffs');
    check(Number.isFinite(cutoffs.fit) && Number.isFinite(cutoffs.margin), 'pooled cutoffs must be finite');
  }
  const ids = models.map((model) => String(model.id));
  check(Array.isArray(pooled.pairs) && pooled.pairs.length === ids.length * (ids.length - 1), 'pooled pairs must cover every ordered model pair');
  const seen = new Set<string>();
  for (const value of pooled.pairs) {
    const pair = object(value, 'pooled pair');
    check(typeof pair.model === 'string' && typeof pair.competitor === 'string' && ids.includes(pair.model) && ids.includes(pair.competitor) && pair.model !== pair.competitor, 'pooled pair models');
    const key = `${pair.model}\n${pair.competitor}`;
    check(!seen.has(key), 'pooled pairs must be unique');
    seen.add(key);
    vector(pair.weights, FAMILY_SIZES.length, 'pooled pair weights');
    check(pair.weights.every((weight) => weight >= 0), 'pooled pair weights must be nonnegative');
    check(Number.isFinite(pair.center) && typeof pair.scale === 'number' && Number.isFinite(pair.scale) && pair.scale > 0, 'pooled pair center and scale');
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run`
Expected:
- The typecheck is clean.
- `tests/pooled-bank.test.ts` passes all 18 tests.
- Every earlier test still passes.

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/data/bank_loader.ts tests/fixtures.ts tests/pooled-bank.test.ts
git commit -m "feat: validate schema-v2 pooled banks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Pooled enrollment

**Files:**
- Create: `src/data/pooled_enrollment.ts`
- Modify: `src/index.ts`, adding exports for `createPooledBank` and `PooledEnrollmentInput`.
- Modify: `src/maintainer.ts`, adding exports for `attachPooledScoring` and `loadBank`.
- Modify: `tests/fixtures.ts`, adding `syntheticRun`, `syntheticEnrollment` and `syntheticPooledBank`.
- Test: `tests/pooled-bank.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 2–4, and `createFingerprintBank` and `EnrollmentInput` from `src/data/enrollment.ts`.
- Produces:
  - Constants: `POOLED_ALPHA = 0.2`, `POOLED_DRAWS = 2000`, `POOLED_SEED = 20261011`.
  - `interface PooledOptions { requestsPerProbe: number; seed?: number }`.
  - `type PooledEnrollmentInput = EnrollmentInput & PooledOptions`.
  - `type EnrolledRuns = readonly { readonly id: string; readonly training: readonly (readonly number[])[]; readonly validation: readonly (readonly number[])[] }[]`.
  - `interface Calibration { totals: FamilyTotals[]; pair(m: number, o: number): PairStatistic; components(m: number): { fit: number; margins: number[] }[] }`.
  - `prepareCalibration(events: readonly (readonly (readonly EventCounts[])[])[]): Calibration`.
  - `attachPooledScoring(bank: FingerprintBank, runs: EnrolledRuns, options: PooledOptions): FingerprintBank`.
  - `createPooledBank(input: PooledEnrollmentInput): FingerprintBank`.
  - Fixtures:
    - `syntheticRun(low: number, high: number, seed: number): number[]`: 64 integers.
    - `syntheticEnrollment(): EnrollmentInput`: three models, `synthetic-1-120`, `synthetic-118-237` and `synthetic-236-355`, with 6 training and 4 validation runs each, transport `openai`, and model `i` training seeds `i*100 + run`.
    - `syntheticPooledBank(requestsPerProbe = 4): FingerprintBank`.

- [ ] **Step 1: Add the fixtures to `tests/fixtures.ts`**

Add these imports:

```ts
import type { EnrollmentInput } from '../src/data/enrollment.js';
import { createPooledBank } from '../src/data/pooled_enrollment.js';
import { mulberry32 } from '../src/math/pooled_sets.js';
```

Append:

```ts
/** 64 integers drawn uniformly from [low, high] with a fixed seed. */
export function syntheticRun(low: number, high: number, seed: number): number[] {
  const random = mulberry32(seed);
  return Array.from({ length: 64 }, () => low + Math.floor(random() * (high - low + 1)));
}

/** Deliberately artificial runs: three models drawing from mostly separate ranges. Never a real model bank. */
export function syntheticEnrollment(): EnrollmentInput {
  return {
    source: 'SYNTHETIC POOLED TEST FIXTURE; no real model measurements',
    protocol: { id: 'integer-v1', targetSamples: 64, language: 'en', temperature: null, transport: 'openai' },
    checkpoints: [64],
    models: ([[1, 120], [118, 237], [236, 355]] as const).map(([low, high], index) => ({
      id: `synthetic-${low}-${high}`, family: 'synthetic',
      training: Array.from({ length: 6 }, (_, run) => syntheticRun(low, high, index * 100 + run)),
      validation: Array.from({ length: 4 }, (_, run) => syntheticRun(low, high, index * 100 + 50 + run)),
    })),
  };
}

export function syntheticPooledBank(requestsPerProbe = 4): FingerprintBank {
  return createPooledBank({ ...syntheticEnrollment(), requestsPerProbe });
}
```

- [ ] **Step 2: Append the failing tests to `tests/pooled-bank.test.ts`**

Add imports:

```ts
import { createFingerprintBank } from '../src/data/enrollment.js';
import { createPooledBank, prepareCalibration, type PooledEnrollmentInput } from '../src/data/pooled_enrollment.js';
import { countEvents, FAMILY_SIZES, logLikelihoods } from '../src/math/pooled_features.js';
import { syntheticEnrollment, syntheticPooledBank } from './fixtures.js';
```

Merge `syntheticEnrollment` and `syntheticPooledBank` into the existing `./fixtures.js` import line rather than adding a second one.

Append:

```ts
describe('pooled enrollment', () => {
  it('extends the v1 bank of the same runs with a seeded, repeatable pooled section', () => {
    const bank = syntheticPooledBank();
    expect(JSON.stringify(syntheticPooledBank())).toBe(JSON.stringify(bank));
    expect(bank).toMatchObject({
      schemaVersion: 2,
      protocol: { id: 'integer-v1', targetSamples: 64, requestsPerProbe: 4, scoring: 'pooled-sets-v1' },
      pooled: { alpha: 0.2, bootstrap: { draws: 2000, seed: 20261011 } },
    });
    expect(bank.pooled!.pairs).toHaveLength(6);
    expect(bank.pooled!.models.map((model) => model.families.map((family) => family.length))).toEqual(Array(3).fill([...FAMILY_SIZES]));
    const v1 = createFingerprintBank(syntheticEnrollment());
    expect(bank.models).toEqual(v1.models);
    expect(bank.calibration).toEqual(v1.calibration);
  });

  it('records a custom seed, which changes only the cutoffs', () => {
    const custom = createPooledBank({ ...syntheticEnrollment(), requestsPerProbe: 4, seed: 7 });
    const standard = syntheticPooledBank();
    expect(custom.pooled!.bootstrap.seed).toBe(7);
    expect(custom.pooled!.models.map((model) => model.cutoffs)).not.toEqual(standard.pooled!.models.map((model) => model.cutoffs));
    expect(custom.pooled!.pairs).toEqual(standard.pooled!.pairs);
  });

  it('scores each calibration run with statistics fitted without it', () => {
    const events = syntheticEnrollment().models.map((model) => [...model.training, ...model.validation].map((run) => countEvents(run)));
    const calibration = prepareCalibration(events);
    const inSample = logLikelihoods(events[0]![0]!, calibration.totals[0]!).reduce((sum, value) => sum + value, 0);
    const [first] = calibration.components(0);
    expect(first!.fit).toBeLessThan(inSample);
    expect(first!.margins).toHaveLength(2);
  });

  it.each<[string, (input: PooledEnrollmentInput) => void, string]>([
    ['one model', (input) => { input.models.length = 1; }, 'at least two models'],
    ['a run of the wrong length', (input) => { input.models[0]!.validation[0] = input.models[0]!.validation[0]!.slice(1); }, 'target sample budget'],
    ['one request per probe', (input) => { input.requestsPerProbe = 1; }, 'requestsPerProbe'],
    ['a negative seed', (input) => { input.seed = -1; }, 'seed'],
  ])('rejects %s', (_name, mutate, message) => {
    const input: PooledEnrollmentInput = { ...syntheticEnrollment(), requestsPerProbe: 4 };
    mutate(input);
    expect(() => createPooledBank(input)).toThrow(message);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/pooled-bank.test.ts`
Expected: FAIL with `Cannot find module '../src/data/pooled_enrollment.js'`.

- [ ] **Step 4: Implement `src/data/pooled_enrollment.ts`**

```ts
import type { FingerprintBank, PooledScoring } from '../core/types.js';
import { countEvents, logLikelihoods, POOLED_SCORING, smoothFamilies, sumFamilies, type EventCounts, type FamilyTotals } from '../math/pooled_features.js';
import { aggregateScores, cutoffIndex, fitPairStatistic, mulberry32, pairScore, type PairStatistic } from '../math/pooled_sets.js';
import { validateBank } from './bank_loader.js';
import { createFingerprintBank, type EnrollmentInput } from './enrollment.js';

/** Target miscoverage of a pooled bank, split equally between the fit and margin tests. */
export const POOLED_ALPHA = 0.2;
export const POOLED_DRAWS = 2000;
export const POOLED_SEED = 20261011;

export interface PooledOptions {
  requestsPerProbe: number;
  /** Bootstrap seed; recorded in the bank. Defaults to POOLED_SEED. */
  seed?: number;
}

export type PooledEnrollmentInput = EnrollmentInput & PooledOptions;

/** Labeled runs behind a bank's models, in bank order. */
export type EnrolledRuns = readonly { readonly id: string; readonly training: readonly (readonly number[])[]; readonly validation: readonly (readonly number[])[] }[];

export interface Calibration {
  totals: FamilyTotals[];
  /** Pair statistic of model m against competitor o, fitted on all runs of both. */
  pair(m: number, o: number): PairStatistic;
  /** Model m's calibration components: each run's fit and margins come from statistics fitted without it. */
  components(m: number): { fit: number; margins: number[] }[];
}

/** Cross-fitted statistics over `events[model][run][group]`, where every run of a model calibrates it. */
export function prepareCalibration(events: readonly (readonly (readonly EventCounts[])[])[]): Calibration {
  const totals = events.map((runs) => sumFamilies(runs));
  // ll[a][i][m]: run i of model a under model m, leaving the run out of its own model.
  const ll = events.map((runs, a) => runs.map((run) => totals.map((model, m) => logLikelihoods(run, model, m === a ? run : undefined))));
  const ratio = (a: number, i: number, m: number, o: number) => ll[a]![i]![m]!.map((value, group) => value - ll[a]![i]![o]![group]!);
  const indices = (a: number) => events[a]!.map((_, i) => i);
  const fit = (m: number, own: readonly number[], o: number) =>
    fitPairStatistic(own.map((i) => ratio(m, i, m, o)), indices(o).map((j) => ratio(o, j, m, o)));
  return {
    totals,
    pair: (m, o) => fit(m, indices(m), o),
    components: (m) => indices(m).map((i) => ({
      fit: ll[m]![i]![m]!.reduce((sum, value) => sum + value, 0),
      margins: events.map((_, o) => o).filter((o) => o !== m)
        .map((o) => pairScore(fit(m, indices(m).filter((j) => j !== i), o), ratio(m, i, m, o))),
    })),
  };
}

/**
 * Extend a v1 bank with prediction-set calibration fitted from the same runs (schema version 2).
 * Envelopes, probabilities, and provenance stay as they are.
 */
export function attachPooledScoring(bank: FingerprintBank, runs: EnrolledRuns, options: PooledOptions): FingerprintBank {
  const { requestsPerProbe, seed = POOLED_SEED } = options;
  if (!Number.isInteger(requestsPerProbe) || requestsPerProbe < 2 || requestsPerProbe > 64) throw new TypeError('requestsPerProbe must be an integer from 2 to 64');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new TypeError('The pooled bootstrap seed must be an unsigned 32-bit integer');
  if (bank.schemaVersion !== 1 || bank.models.length < 2) throw new TypeError('Pooled scoring extends a v1 bank of at least two models');
  if (runs.length !== bank.models.length || runs.some((model, index) => model.id !== bank.models[index]!.id)) {
    throw new TypeError('Pooled enrollment runs must list the bank models in bank order');
  }
  const events = runs.map((model) => [...model.training, ...model.validation].map((run) => {
    if (run.length !== bank.protocol.targetSamples) throw new TypeError('Every pooled enrollment run must match the target sample budget');
    return countEvents(run);
  }));
  const calibration = prepareCalibration(events);
  const pairs: PooledScoring['pairs'] = [];
  for (const [m, model] of runs.entries()) {
    for (const [o, competitor] of runs.entries()) if (o !== m) pairs.push({ model: model.id, competitor: competitor.id, ...calibration.pair(m, o) });
  }
  const random = mulberry32(seed);
  const index = cutoffIndex(POOLED_ALPHA, POOLED_DRAWS);
  const models = runs.map((_, m) => {
    const components = calibration.components(m);
    const fits: number[] = [];
    const margins: number[] = [];
    for (let draw = 0; draw < POOLED_DRAWS; draw++) {
      const tuple = Array.from({ length: requestsPerProbe }, () => components[Math.floor(random() * components.length)]!);
      const scores = aggregateScores(tuple.map((part) => part.fit), tuple.map((part) => part.margins));
      fits.push(scores.fit);
      margins.push(scores.margin);
    }
    fits.sort((a, b) => a - b);
    margins.sort((a, b) => a - b);
    return { families: smoothFamilies(calibration.totals[m]!), cutoffs: { fit: fits[index]!, margin: margins[index]! } };
  });
  return validateBank({
    ...bank, schemaVersion: 2,
    protocol: { ...bank.protocol, requestsPerProbe, scoring: POOLED_SCORING },
    pooled: { alpha: POOLED_ALPHA, bootstrap: { draws: POOLED_DRAWS, seed }, models, pairs },
  });
}

/** Build a pooled bank from labeled runs: v1 envelopes plus prediction-set calibration. */
export function createPooledBank(input: PooledEnrollmentInput): FingerprintBank {
  const { requestsPerProbe, seed, ...enrollment } = input;
  return attachPooledScoring(createFingerprintBank(enrollment), enrollment.models, { requestsPerProbe, ...(seed === undefined ? {} : { seed }) });
}
```

- [ ] **Step 5: Export it**

In `src/index.ts`, add after the `createFingerprintBank` export line:

```ts
export { createPooledBank, type PooledEnrollmentInput } from './data/pooled_enrollment.js';
```

In `src/maintainer.ts`, append:

```ts
export { loadBank } from './data/bank_loader.js';
export { attachPooledScoring } from './data/pooled_enrollment.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run tests/pooled-bank.test.ts`
Expected: the typecheck is clean, and 25 tests pass (18 from Task 4 plus 7 new).

- [ ] **Step 7: Commit**

```bash
git add src/data/pooled_enrollment.ts src/index.ts src/maintainer.ts tests/fixtures.ts tests/pooled-bank.test.ts
git commit -m "feat: enroll pooled banks with cross-fitted bootstrap cutoffs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Engine: pooled collection and classification

**Files:**
- Modify: `src/core/abort.ts` (add `childScope`)
- Create: `src/core/pooled.ts`
- Modify: `src/core/engine.ts` (`ProbePlan`, `planProbe`, `fingerprint`, plus new `collectPooled` and `classifyPooledProbe`)
- Modify: `tests/fixtures.ts` (add `SequenceTransport`, `openEnvelopes`, `forceCutoffs`)
- Test: `tests/pooled-engine.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `childScope(parent: AbortSignal): { controller: AbortController; signal: AbortSignal; dispose: () => void }`.
  - `classifyPooled(responses: readonly (readonly number[])[], bank: FingerprintBank, project: Projector): { candidates: string[]; scores: ModelScore[] }`.
  - `ProbePlan.requests: number`.
  - `ProbeResult.candidates` and `requests` are filled in pooled mode.
  - Fixtures:
    - `class SequenceTransport`, with constructor `(replies: (string[] | 'stall')[], granularity = 'token', name = 'openai')`, and fields `requests`, `abortedAtStart: boolean[]` and `onRequest?: (index: number) => void`.
    - `openEnvelopes(bank): FingerprintBank`.
    - `forceCutoffs(bank, pass: readonly boolean[]): FingerprintBank`.

- [ ] **Step 1: Add the fixtures to `tests/fixtures.ts`**

```ts
/** Answers request i with replies[i]; 'stall' waits until the request is aborted. */
export class SequenceTransport implements ProbeTransport {
  requests: ProbeRequest[] = [];
  abortedAtStart: boolean[] = [];
  onRequest?: (index: number) => void;
  constructor(private readonly replies: (string[] | 'stall')[], readonly granularity: StreamGranularity = 'token', readonly name: string = 'openai') {}

  async *stream(request: ProbeRequest): AsyncGenerator<string> {
    const index = this.requests.push(request) - 1;
    this.abortedAtStart.push(request.signal?.aborted ?? false);
    this.onRequest?.(index);
    const reply = this.replies[index] ?? [];
    if (reply === 'stall') {
      request.signal?.throwIfAborted();
      await new Promise<never>((_, reject) => request.signal?.addEventListener('abort', () => reject(request.signal!.reason), { once: true }));
      return;
    }
    for (const chunk of reply) {
      request.signal?.throwIfAborted();
      yield chunk;
    }
  }
}

/** Accept every response in every envelope, so a test isolates the fit and margin tests. */
export function openEnvelopes(bank: FingerprintBank): FingerprintBank {
  for (const model of bank.models) for (const profile of model.profiles) { profile.maxHellinger = 1; profile.maxMahalanobis = Number.MAX_VALUE; }
  return bank;
}

/** Force each model into (`true`) or out of the prediction set through its cutoffs. */
export function forceCutoffs(bank: FingerprintBank, pass: readonly boolean[]): FingerprintBank {
  bank.pooled!.models.forEach((model, index) => {
    const value = pass[index] ? -1e12 : 1e12;
    model.cutoffs = { fit: value, margin: value };
  });
  return bank;
}
```

- [ ] **Step 2: Write the failing tests in `tests/pooled-engine.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { fingerprint, planProbe } from '../src/core/engine.js';
import { integerPrompt } from '../src/probes/templates.js';
import { tokenizerPrompt } from '../src/probes/tokenizer.js';
import { forceCutoffs, openEnvelopes, SequenceTransport, syntheticPooledBank, syntheticRun } from './fixtures.js';

const LOW = 'synthetic-1-120';
const MID = 'synthetic-118-237';
const HIGH = 'synthetic-236-355';
/** The low-range model's own training runs, as complete replies. */
const lowReplies = (count = 4) => Array.from({ length: count }, (_, run) => [`${syntheticRun(1, 120, run).join(' ')} `]);

describe('pooled probes', () => {
  it('names the only model that fits every response as a heuristic match', async () => {
    const transport = new SequenceTransport(lowReplies());
    const result = await fingerprint(transport, { bank: openEnvelopes(syntheticPooledBank()) });
    expect(result).toMatchObject({
      status: 'HEURISTIC_MATCH', model: LOW, candidates: [LOW], confidence: null, requests: 4,
      requestedSamples: 256, evaluatedSamples: 256, earlyStopped: false,
    });
    expect(result.samples).toEqual(Array.from({ length: 4 }, (_, run) => syntheticRun(1, 120, run)).flat());
    expect(result.reason).toContain('an unenrolled model from the same vendor');
    expect(transport.requests.map((request) => request.prompt)).toEqual(Array(4).fill(integerPrompt(64, 'en')));
    const low = result.scores.find((score) => score.id === LOW)!;
    expect(low.fit).toBeGreaterThanOrEqual(low.fitCutoff!);
    expect(low.margin).toBeGreaterThanOrEqual(low.marginCutoff!);
    expect(result.warnings.join(' ')).toContain('4 requests of 64 integers');
  });

  it.each([
    [[true, true, false], 'INCONCLUSIVE', null, [LOW, MID], 'Consistent with synthetic-1-120 or synthetic-118-237'],
    [[false, false, false], 'UNKNOWN_MODEL', null, [], 'No enrolled model fits all 4 responses'],
    [[false, false, true], 'HEURISTIC_MATCH', HIGH, [HIGH], 'Only synthetic-236-355 fits all 4 responses'],
  ] as const)('maps the prediction set %j to its status', async (pass, status, model, candidates, reason) => {
    const result = await fingerprint(new SequenceTransport(lowReplies()), { bank: forceCutoffs(openEnvelopes(syntheticPooledBank()), pass) });
    expect(result).toMatchObject({ status, model, candidates: [...candidates], confidence: null });
    expect(result.reason).toContain(reason);
  });

  it('drops a model whose envelope rejects any response', async () => {
    const bank = forceCutoffs(openEnvelopes(syntheticPooledBank()), [true, true, true]);
    bank.models[2]!.profiles[0]!.maxHellinger = 1e-9;
    const result = await fingerprint(new SequenceTransport(lowReplies()), { bank });
    expect(result.candidates).toEqual([LOW, MID]);
    expect(result.scores.find((score) => score.id === HIGH)).toMatchObject({ accepted: false, weight: null });
  });

  it('stops at a short reply and names the request', async () => {
    const replies = lowReplies();
    replies[2] = [`${syntheticRun(1, 120, 2).slice(0, 63).join(' ')} `];
    const transport = new SequenceTransport(replies);
    const result = await fingerprint(transport, { bank: syntheticPooledBank() });
    expect(result).toMatchObject({ status: 'INCONCLUSIVE', model: null, requests: 3, evaluatedSamples: 0, scores: [] });
    expect(result.candidates).toBeUndefined();
    expect(result.reason).toContain('Request 3 of 4 ended after 63 of 64 integers');
    expect(result.reason).toContain('384-token output limit');
    expect(result.samples).toHaveLength(191);
    expect(transport.requests).toHaveLength(3);
  });

  it('stops each request at 64 integers without cancelling the next one', async () => {
    const transport = new SequenceTransport(lowReplies().map(([text]) => [text!, '17 18 19 20 ']));
    const result = await fingerprint(transport, { bank: openEnvelopes(syntheticPooledBank()) });
    expect(transport.abortedAtStart).toEqual([false, false, false, false]);
    expect(result.samples).toHaveLength(256);
    expect(result.status).toBe('HEURISTIC_MATCH');
  });

  it('applies the overall deadline across requests', async () => {
    const transport = new SequenceTransport([...lowReplies(2), 'stall', ...lowReplies(1)]);
    await expect(fingerprint(transport, { bank: syntheticPooledBank(), timeoutMs: 200 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(transport.requests).toHaveLength(3);
  });

  it('sends no further requests after cancellation', async () => {
    const controller = new AbortController();
    const transport = new SequenceTransport([...lowReplies(2), 'stall', ...lowReplies(1)]);
    transport.onRequest = (index) => { if (index === 2) controller.abort(new Error('Interrupted')); };
    await expect(fingerprint(transport, { bank: syntheticPooledBank(), signal: controller.signal })).rejects.toThrow('Interrupted');
    expect(transport.requests).toHaveLength(3);
  });

  it('requires the bank sample count before any request', async () => {
    const transport = new SequenceTransport(lowReplies());
    await expect(fingerprint(transport, { bank: syntheticPooledBank(), samples: 512 })).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' });
    expect(transport.requests).toHaveLength(0);
  });

  it('runs the optional tokenizer probe before the pooled requests', async () => {
    const transport = new SequenceTransport([['a | b'], ...lowReplies()]);
    const result = await fingerprint(transport, { bank: openEnvelopes(syntheticPooledBank()), tokenizerProbe: true });
    expect(transport.requests.map((request) => request.prompt)).toEqual([tokenizerPrompt('en'), ...Array(4).fill(integerPrompt(64, 'en'))]);
    expect(result).toMatchObject({ status: 'HEURISTIC_MATCH', requests: 4, tokenizer: { response: 'a | b', diagnosticOnly: true } });
  });

  it('plans the bank request count and never stops early', () => {
    const bank = syntheticPooledBank();
    bank.calibration!.sequentialValidated = true;
    expect(planProbe({ name: 'openai', granularity: 'token' }, bank, true)).toMatchObject({ requests: 4, count: 64, canStop: false });
  });

  it('labels a cross-transport pooled result as experimental', async () => {
    const transport = new SequenceTransport(lowReplies(), 'message', 'codex');
    const result = await fingerprint(transport, { bank: openEnvelopes(syntheticPooledBank()), allowTransportMismatch: true });
    expect(result).toMatchObject({ status: 'HEURISTIC_MATCH', model: LOW, crossTransport: { probeTransport: 'codex', bankTransport: 'openai' } });
    expect(result.reason).toMatch(/^Experimental comparison across transports\./);
  });

  it('reports progress across requests', async () => {
    const counts: number[] = [];
    await fingerprint(new SequenceTransport(lowReplies()), { bank: syntheticPooledBank(), onProgress: (count) => counts.push(count) });
    expect(counts[64]).toBe(65);
    expect(counts.at(-1)).toBe(256);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/pooled-engine.test.ts`
Expected: FAIL. The engine sends one request, and `requests` and `candidates` are undefined.

- [ ] **Step 4: Add `childScope` to `src/core/abort.ts`**

Append:

```ts
/** A scope that aborts with `parent` and can also be aborted on its own, e.g. to end one request of several. */
export function childScope(parent: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener('abort', abort, { once: true });
  return { controller, signal: controller.signal, dispose: () => parent.removeEventListener('abort', abort) };
}
```

- [ ] **Step 5: Create `src/core/pooled.ts`**

```ts
import type { Projector } from '../math/nuisance.js';
import { assessOOD } from '../math/ood.js';
import { orderedBlockFeatures } from '../math/ordered_block.js';
import { countEvents, familyLogLikelihoods } from '../math/pooled_features.js';
import { aggregateScores, pairScore } from '../math/pooled_sets.js';
import type { FingerprintBank, ModelScore } from './types.js';

/**
 * Prediction set of a pooled bank over complete responses of `targetSamples` integers each: models
 * that pass their fit and margin cutoffs and whose envelope accepts every response, in bank order.
 */
export function classifyPooled(responses: readonly (readonly number[])[], bank: FingerprintBank, project: Projector): { candidates: string[]; scores: ModelScore[] } {
  const pooled = bank.pooled!;
  const logs = pooled.models.map((model) => model.families.map((family) => family.map(Math.log)));
  // ll[j][m]: per-group log-likelihoods of response j under model m.
  const ll = responses.map((response) => {
    const events = countEvents(response);
    return logs.map((model) => familyLogLikelihoods(events, model));
  });
  const features = responses.map((response) => orderedBlockFeatures(response).vector);
  const pairs = new Map(pooled.pairs.map((pair) => [`${pair.model}\n${pair.competitor}`, pair]));
  const candidates: string[] = [];
  const scores = bank.models.map((model, m): ModelScore => {
    const competitors = bank.models.map((_, o) => o).filter((o) => o !== m);
    const { fit, margin } = aggregateScores(
      ll.map((response) => response[m]!.reduce((sum, value) => sum + value, 0)),
      ll.map((response) => competitors.map((o) => pairScore(
        pairs.get(`${model.id}\n${bank.models[o]!.id}`)!,
        response[m]!.map((value, group) => value - response[o]![group]!),
      ))),
    );
    const profile = model.profiles.find((entry) => entry.sampleCount === bank.protocol.targetSamples)!;
    const distances = features.map((vector) => assessOOD(vector, profile, project));
    const accepted = distances.every((distance) => distance.accepted);
    const { fit: fitCutoff, margin: marginCutoff } = pooled.models[m]!.cutoffs;
    if (accepted && fit >= fitCutoff && margin >= marginCutoff) candidates.push(model.id);
    return {
      id: model.id, weight: null, accepted,
      hellinger: Math.max(...distances.map((distance) => distance.hellinger)),
      mahalanobis: Math.max(...distances.map((distance) => distance.mahalanobis)),
      fit, margin, fitCutoff, marginCutoff,
    };
  });
  return { candidates, scores };
}
```

- [ ] **Step 6: Wire the pooled path into `src/core/engine.ts`**

1. Update the imports:

```ts
import { abortScope, childScope, DEFAULT_TIMEOUT_MS } from './abort.js';
import { classifyPooled } from './pooled.js';
```

2. In `interface ProbePlan`, add after `count: number;`:

```ts
  /** Requests per probe: 1, or a pooled bank's requestsPerProbe. */
  requests: number;
```

3. In `planProbe`, add after `const count = …;`:

```ts
  const requests = bank.protocol.requestsPerProbe ?? 1;
```

Then add this immediately before the line `if (!calibrated.length || !bank.calibration?.sequentialValidated) warnings.push('Early stopping is disabled …`:

```ts
  if (requests > 1 && calibrated.length) {
    warnings.push(`Experimental pooled probe: ${requests} requests of ${count} integers each. A single-model result is a heuristic match: an unenrolled model from the same vendor as an enrolled one can produce it.`);
  }
```

4. In the object `planProbe` returns:
   - Change `calibrated, crossTransport, incompatibleDefault, count, maxTokens,` to `calibrated, crossTransport, incompatibleDefault, count, requests, maxTokens,`.
   - Change `canStop: !crossTransport && …` to `canStop: requests === 1 && !crossTransport && …`.

5. Add these functions below `collectIntegers`:

```ts
interface PooledCollection {
  /** Complete responses, each its fixed prefix of the requested count. */
  responses: number[][];
  /** Integers of the first reply that ended early; no request follows it. */
  short?: number[];
}

/** Send a pooled bank's requests one after another under the probe's overall deadline. */
async function collectPooled(
  transport: ProbeTransport,
  bank: FingerprintBank,
  plan: ProbePlan,
  scope: ReturnType<typeof abortScope>,
  request: RequestOptions,
  options: EngineOptions,
): Promise<PooledCollection> {
  const responses: number[][] = [];
  for (let index = 0; index < plan.requests; index++) {
    // Reaching the count aborts only this request's scope; the overall deadline still ends every request.
    const child = childScope(scope.signal);
    try {
      const offset = index * plan.count;
      const { samples } = await collectIntegers(transport, bank, plan, child, { ...request, signal: child.signal },
        { ...options, onProgress: (count) => options.onProgress?.(offset + count) });
      scope.signal.throwIfAborted();
      if (samples.length < plan.count) return { responses, short: samples };
      responses.push(samples);
    } finally { child.dispose(); }
  }
  return { responses };
}

/** One candidate is a heuristic match, more are inconclusive, none is an unknown model. */
function classifyPooledProbe(responses: number[][], bank: FingerprintBank, plan: ProbePlan): { classification: Classification; candidates: string[] } {
  const { candidates, scores } = classifyPooled(responses, bank, createNuisanceProjector(bank.nuisanceDirections));
  const shared = { confidence: null, scores, evaluatedSamples: responses.length * plan.count };
  const every = `all ${plan.requests} responses`;
  if (candidates.length === 1) {
    return { candidates, classification: { ...shared, status: 'HEURISTIC_MATCH', model: candidates[0]!,
      reason: `Only ${candidates[0]} fits ${every} among enrolled models; an unenrolled model from the same vendor can produce the same result.` } };
  }
  if (candidates.length > 1) {
    return { candidates, classification: { ...shared, status: 'INCONCLUSIVE', model: null,
      reason: `Consistent with ${candidates.slice(0, -1).join(', ')} or ${candidates.at(-1)}; the responses do not separate them.` } };
  }
  return { candidates, classification: { ...shared, status: 'UNKNOWN_MODEL', model: null, reason: `No enrolled model fits ${every}.` } };
}
```

6. In `fingerprint`, insert this immediately after the tokenizer block. That is, after the `if (options.tokenizerProbe === true) { … }` block and before `const { samples, early, test, project } = await collectIntegers(…)`:

```ts
    if (plan.requests > 1) {
      const { responses, short } = await collectPooled(transport, bank, plan, scope, request, options);
      options.signal?.throwIfAborted();
      const sent = responses.length + (short ? 1 : 0);
      const pooled = short ? undefined : classifyPooledProbe(responses, bank, plan);
      if (short) warnings.push(`Request ${sent} ended after ${short.length} of ${plan.count} requested integers (output limit: ${plan.maxTokens} tokens); no further requests were sent.`);
      const classification: Classification = pooled?.classification ?? {
        status: 'INCONCLUSIVE', model: null, confidence: null, scores: [], evaluatedSamples: 0,
        reason: `Request ${sent} of ${plan.requests} ended after ${short!.length} of ${plan.count} integers; a pooled probe needs every request complete. A provider stop or the ${plan.maxTokens}-token output limit ends a response early; reasoning models may need a larger maxTokens.`,
      };
      return {
        ...relabel(classification, plan, transport, bank),
        confidenceMeaning: 'nominal closed-set IID likelihood; not calibrated identity probability',
        samples: [...responses.flat(), ...(short ?? [])], requestedSamples: plan.count * plan.requests,
        earlyStopped: false, sampleBudgetSaved: 0,
        elapsedMs: Math.round(performance.now() - started), streamGranularity: transport.granularity,
        tokenizer, warnings, requests: sent,
        ...(pooled ? { candidates: pooled.candidates } : {}),
        ...(plan.crossTransport ? { crossTransport: { probeTransport: transport.name, bankTransport: bank.protocol.transport } } : {}),
      };
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run`
Expected:
- The typecheck is clean.
- `tests/pooled-engine.test.ts` passes all 14 tests.
- Every earlier test still passes, since the v1 path is unchanged.

- [ ] **Step 8: Commit**

```bash
git add src/core/abort.ts src/core/pooled.ts src/core/engine.ts tests/fixtures.ts tests/pooled-engine.test.ts
git commit -m "feat: probe pooled banks with sequential requests and prediction sets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Bank updater support

**Files:**
- Modify: `src/data/gateway_config.ts` (parse `scoring` and `requestsPerProbe`)
- Modify: `src/data/gateway_update.ts` (`enroll`, `updateGatewayBank`)
- Create: `config/pooled-bank-update.json`
- Modify: `.gitignore`, `docs/bank-maintenance.md`
- Test: `tests/gateway-update.test.ts` (append)

**Interfaces:**
- Consumes: `attachPooledScoring` (Task 5) and `POOLED_SCORING` (Task 2).
- Produces:
  - `GatewayBankConfig.scoring?: 'pooled-sets-v1'` and `GatewayBankConfig.requestsPerProbe?: number`. They are always set together.
  - These fields are top-level, so they are not part of the collection checkpoint hash: the same collected runs can be enrolled either way.

- [ ] **Step 1: Append the failing tests to `tests/gateway-update.test.ts`**

Add the configuration cases at the end of `describe('Gateway bank configuration', …)`:

```ts
  it('parses pooled scoring and requires both of its fields', () => {
    expect(parseGatewayBankConfig({ ...input(), scoring: 'pooled-sets-v1', requestsPerProbe: 8 }, credentials))
      .toMatchObject({ scoring: 'pooled-sets-v1', requestsPerProbe: 8 });
    expect(parseGatewayBankConfig(input(), credentials)).not.toHaveProperty('scoring');
    for (const extra of [{ scoring: 'pooled-sets-v1' }, { requestsPerProbe: 8 }, { scoring: 'other', requestsPerProbe: 8 }, { scoring: 'pooled-sets-v1', requestsPerProbe: 1 }, { scoring: 'pooled-sets-v1', requestsPerProbe: 65 }]) {
      expect(() => parseGatewayBankConfig({ ...input(), ...extra }, credentials)).toThrow('Invalid bank-update config');
    }
  });
```

Add the update cases at the end of `describe('Gateway collection and atomic bank updates', …)`:

```ts
  it('writes a pooled bank when the configuration sets pooled scoring', async () => {
    const pooled = parseGatewayBankConfig({ ...input(), scoring: 'pooled-sets-v1', requestsPerProbe: 2 }, credentials);
    const result = await updateGatewayBank(pooled, { outputPath, fetch: gateway(), now });
    expect(result.bank).toMatchObject({ schemaVersion: 2, protocol: { requestsPerProbe: 2, scoring: 'pooled-sets-v1' } });
    expect(result.bank.pooled!.pairs).toHaveLength(2);
    expect(result.bank.models[0]!.provenance).toContain('corpus sha256:');
    expect((await loadBank(outputPath)).schemaVersion).toBe(2);
  });

  it('refuses incremental updates of pooled banks before any request', async () => {
    const pooled = parseGatewayBankConfig({ ...input(), scoring: 'pooled-sets-v1', requestsPerProbe: 2 }, credentials);
    const fetch = gateway();
    await expect(updateGatewayBank(pooled, { outputPath, fetch, now, incremental: true })).rejects.toThrow('Incremental updates are not supported for pooled banks');
    await updateGatewayBank(pooled, { outputPath, fetch: gateway(), now });
    await expect(updateGatewayBank(config(), { outputPath, fetch, now, incremental: true })).rejects.toThrow('Incremental updates are not supported for pooled banks');
    expect(fetch).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/gateway-update.test.ts -t "pooled"`
Expected: FAIL. `scoring` is rejected with `root has an unsupported field`.

- [ ] **Step 3: Parse the fields in `src/data/gateway_config.ts`**

1. Add an import:

```ts
import { POOLED_SCORING } from '../math/pooled_features.js';
```

2. In `GatewayBankConfig`, add after `maxProbeRetries: number;`:

```ts
  /** Fit pooled prediction-set scoring after collection; not part of the collection checkpoint. */
  scoring?: typeof POOLED_SCORING;
  requestsPerProbe?: number;
```

3. In `parseGatewayBankConfig`, add `'scoring', 'requestsPerProbe'` to the `keys(root, [...], 'root')` list.

4. Add after the `maxProbeRetries` lines:

```ts
  check(root.scoring === undefined || root.scoring === POOLED_SCORING, `scoring must be ${POOLED_SCORING}`);
  check((root.scoring === undefined) === (root.requestsPerProbe === undefined), 'scoring and requestsPerProbe must be set together');
  const requestsPerProbe = root.scoring === undefined ? undefined : integer(root.requestsPerProbe, 2, 64, 'requestsPerProbe');
```

5. In the returned object, change the last line from:

```ts
    checkpoints: counts, trainingRuns, validationRuns, timeoutMs, requestDelayMs, maxRequests, maxProbeRetries, models,
```

to:

```ts
    checkpoints: counts, trainingRuns, validationRuns, timeoutMs, requestDelayMs, maxRequests, maxProbeRetries,
    ...(requestsPerProbe === undefined ? {} : { scoring: POOLED_SCORING, requestsPerProbe }),
    models,
```

- [ ] **Step 4: Enroll and guard in `src/data/gateway_update.ts`**

1. Add an import after the `repetition.js` import:

```ts
import { attachPooledScoring } from './pooled_enrollment.js';
```

2. In `enroll`, replace the final `return bank;` with:

```ts
  return config.requestsPerProbe === undefined ? bank : attachPooledScoring(bank, models, { requestsPerProbe: config.requestsPerProbe });
```

3. In `updateGatewayBank`, add immediately after `const config = parseGatewayBankConfig(input, {});`:

```ts
  // Pooled cutoffs depend on every model's runs, which a bank does not store.
  const pooledIncremental = 'Incremental updates are not supported for pooled banks; run a full update';
  if (options.incremental && config.requestsPerProbe !== undefined) throw new Error(pooledIncremental);
```

4. Add immediately after `const base = options.incremental ? parseIncrementalBase(before) : undefined;`:

```ts
    if (base?.schemaVersion === 2) throw new Error(pooledIncremental);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run tests/gateway-update.test.ts`
Expected: all tests pass, 3 more than before.

- [ ] **Step 6: Add the checked-in pooled configuration**

Generate it from the checked-in 512-integer configuration, so that model routes and API formats stay identical:

```bash
node -e '
const fs = require("fs");
const base = JSON.parse(fs.readFileSync("config/bank-update.json", "utf8"));
const pooled = {
  ...base,
  protocol: { ...base.protocol, targetSamples: 64 },
  checkpoints: [64], trainingRuns: 25, validationRuns: 15, maxRequests: 800,
  scoring: "pooled-sets-v1", requestsPerProbe: 8,
  models: base.models.map((model) => ({ ...model, maxTokens: 4096 })),
};
fs.writeFileSync("config/pooled-bank-update.json", JSON.stringify(pooled, null, 2) + "\n");'
OPENROUTER_API_KEY=dry-run-placeholder node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run bank:check -- --config config/pooled-bank-update.json --output src/data/pooled_bank.json
```

Expected: the dry run prints `Full collection plan: 13 models via OpenRouter; 520 required runs; …; 64 integers per run` and sends nothing. A dry run never contacts the provider, so the placeholder key is never used.

- [ ] **Step 7: Ignore the pooled bank's lock and temporary files**

In `.gitignore`, add after `src/data/default_bank.json.*.tmp`:

```
src/data/pooled_bank.json.lock
src/data/pooled_bank.json.*.tmp
```

- [ ] **Step 8: Document pooled maintenance**

Append to `docs/bank-maintenance.md`:

```markdown
## Pooled banks (experimental)

A pooled bank backs `--pooled`. Each probe sends `requestsPerProbe` requests of `targetSamples` integers, and the bank adds prediction-set calibration to the usual envelopes; see [methodology](methodology.md#experimental-pooled-probe-pooled-sets-v1). [`config/pooled-bank-update.json`](../config/pooled-bank-update.json) sets `"scoring": "pooled-sets-v1"` and `"requestsPerProbe": 8`, with 64 integers, 25 training runs, 15 held-out runs and 4,096 output tokens per request:

    npm run bank:update -- --config config/pooled-bank-update.json --output src/data/pooled_bank.json

Collection, checkpoints, retries, the loop check and provenance work as for the default bank. The scoring fields are not part of the checkpoint, so the same runs can be enrolled either way. Pooled cutoffs depend on every model's runs, which a bank does not store, so `--incremental` is refused for a pooled configuration or an existing pooled bank; run a full update. To add pooled scoring to a bank this updater already collected, without new requests, see `npm run bank:pooled`.
```

- [ ] **Step 9: Commit**

```bash
git add src/data/gateway_config.ts src/data/gateway_update.ts config/pooled-bank-update.json .gitignore docs/bank-maintenance.md tests/gateway-update.test.ts
git commit -m "feat: fit pooled banks in the bank updater

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Bundled pooled bank and `pooledBank()`

**Files:**
- Create: `scripts/build-pooled-bank.mjs`
- Create (generated): `src/data/pooled_bank.json`
- Modify: `package.json` (add a `bank:pooled` script), `src/data/bank_loader.ts` (`pooledBank`), `src/index.ts`, `scripts/package-smoke.mjs`, `docs/library.md`
- Test: `tests/pooled-bank.test.ts` (append)

**Interfaces:**
- Consumes: `attachPooledScoring` and `loadBank` from `build/maintainer.js` (Task 5).
- Produces: `pooledBank(): Promise<FingerprintBank>`, exported from the package.

- [ ] **Step 1: Write `scripts/build-pooled-bank.mjs`**

```js
// Add pooled-sets-v1 scoring to a bank the updater collected, from its archived corpus, without new requests.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { attachPooledScoring, loadBank } from '../build/maintainer.js';

const command = new Command()
  .name('build-pooled-bank')
  .requiredOption('--bank <path>', 'bank written by the updater (schema version 1)')
  .requiredOption('--corpus <path>', 'the corpus archived with that bank')
  .requiredOption('--output <path>', 'new pooled bank path; an existing file is never overwritten')
  .option('--requests <count>', 'requests per probe', '8');
command.parse();
const options = command.opts();
const bank = await loadBank(options.bank);
const { protocol, checkpoints, models } = JSON.parse(await readFile(options.corpus, 'utf8'));
// The updater records this digest in every collected model's provenance.
const digest = createHash('sha256').update(JSON.stringify({ protocol, checkpoints, models })).digest('hex');
for (const model of bank.models) {
  if (!model.provenance.includes(`corpus sha256:${digest};`)) throw new Error(`${model.id} was not fitted from this corpus (sha256:${digest})`);
}
const pooled = attachPooledScoring(bank, models, { requestsPerProbe: Number(options.requests) });
await writeFile(options.output, `${JSON.stringify(pooled, null, 2)}\n`, { flag: 'wx' });
console.log(`Wrote ${options.output}: ${pooled.models.length} models, ${pooled.protocol.requestsPerProbe} requests × ${pooled.protocol.targetSamples} integers, corpus sha256:${digest}.`);
```

In `package.json` `scripts`, add after `bank:check`:

```json
    "bank:pooled": "npm run build && node scripts/build-pooled-bank.mjs",
```

- [ ] **Step 2: Generate the bundled bank**

```bash
node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run bank:pooled -- --bank research-64.local.json --corpus research-64.local.json.corpus-4d34afe7497e9d0d83238136885022a808a5c0e6ecfcfc32b7ed5689131f0bbf.json --output src/data/pooled_bank.json
ls -la src/data/pooled_bank.json
```

Expected:
- The script prints `Wrote src/data/pooled_bank.json: 13 models, 8 requests × 64 integers, corpus sha256:4d34afe7497e9d0d83238136885022a808a5c0e6ecfcfc32b7ed5689131f0bbf.`
- The file is roughly 2–4 MB.

- [ ] **Step 3: Append the failing tests to `tests/pooled-bank.test.ts`**

Add `pooledBank` to the `bank_loader.js` import. Then append:

```ts
describe('bundled pooled bank', () => {
  it('loads a validated 13-model bank of 8 requests × 64 integers', async () => {
    const bank = await pooledBank();
    expect(bank).toMatchObject({
      schemaVersion: 2,
      protocol: { id: 'integer-v1', language: 'en', targetSamples: 64, temperature: null, transport: 'api', requestsPerProbe: 8, scoring: 'pooled-sets-v1' },
      pooled: { alpha: 0.2, bootstrap: { draws: 2000, seed: 20261011 } },
    });
    expect(bank.models).toHaveLength(13);
    expect(bank.pooled!.pairs).toHaveLength(156);
    for (const model of bank.models) expect(model.provenance).toContain('corpus sha256:4d34afe7497e9d0d83238136885022a808a5c0e6ecfcfc32b7ed5689131f0bbf;');
  });

  it('returns an independent copy', async () => {
    const bank = await pooledBank();
    bank.pooled!.models[0]!.cutoffs.fit = 0;
    expect((await pooledBank()).pooled!.models[0]!.cutoffs.fit).not.toBe(0);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/pooled-bank.test.ts -t "bundled"`
Expected: FAIL with `pooledBank is not a function` or a missing export.

- [ ] **Step 5: Add `pooledBank()`**

In `src/data/bank_loader.ts`, add after `defaultBank`:

```ts
/** The bundled experimental pooled bank (schema version 2), loaded on first use. */
export async function pooledBank(): Promise<FingerprintBank> {
  const { default: bank } = await import('./pooled_bank.json');
  return validateBank(bank);
}
```

In `src/index.ts`, change the bank-loader export to:

```ts
export { defaultBank, loadBank, pooledBank, validateBank } from './data/bank_loader.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run tests/pooled-bank.test.ts`
Expected: all 27 tests pass.

- [ ] **Step 7: Check the build output and extend the package smoke test**

Run: `node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run build && ls dist`

Expected:
- `dist` holds one `chunk-*.js` plus a separate lazily loaded `pooled_bank-*.js`. esbuild names a dynamic-import chunk after its module.
- If the lazy chunk has a different name, use that name in the regex below.
- `index.cjs` grows by about the pooled bank's size, because CommonJS inlines it.

In `scripts/package-smoke.mjs`, add after the stale-chunk assertion:

```js
  assert.equal(packedFiles.filter((path) => /^dist\/pooled_bank-[^/]+\.js$/.test(path)).length, 1, 'the pooled bank ships as one lazily loaded ESM chunk');
```

and after `assert.deepEqual(esm.validateBank(esm.defaultBank()), esm.defaultBank());`:

```js
  for (const library of [esm, cjs]) assert.equal((await library.pooledBank()).protocol.requestsPerProbe, 8);
```

Run: `node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run test:package`
Expected: the final line, `Tarball install, both aliases, ESM/CJS exports, declarations, HTTP CLI, interrupt cleanup, and bank creation pass.`

- [ ] **Step 8: Document the library additions**

Append to `docs/library.md`, before `## Custom transports`:

```markdown
## Experimental pooled probe

`pooledBank()` resolves to the bundled pooled bank: 8 requests of 64 integers, scored as a prediction set (see [methodology](methodology.md#experimental-pooled-probe-pooled-sets-v1)). Pass it as `bank`: `fingerprint(transport, { bank: await pooledBank(), maxTokens: 4096 })`. A single-model set returns `HEURISTIC_MATCH`, with the candidate in `model` and `confidence: null`. Two or more return `INCONCLUSIVE`, and none returns `UNKNOWN_MODEL`. `candidates` lists the set and `requests` the requests sent. An unenrolled model from the same vendor as an enrolled one can produce a single-model set. `createPooledBank(input)` builds a pooled bank from the same enrollment input as `createFingerprintBank`, plus `requestsPerProbe`.
```

- [ ] **Step 9: Commit**

```bash
git add scripts/build-pooled-bank.mjs src/data/pooled_bank.json package.json src/data/bank_loader.ts src/index.ts scripts/package-smoke.mjs docs/library.md tests/pooled-bank.test.ts
git commit -m "feat: bundle the experimental pooled bank

Built from the 2026-10-11 OpenRouter collection of 13 models with 25
training and 15 held-out runs of 64 integers each (corpus sha256
4d34afe7497e9d0d83238136885022a808a5c0e6ecfcfc32b7ed5689131f0bbf).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: CLI `--pooled`

**Files:**
- Modify: `src/cli.ts` (`Options`, the option, the action, `interactive`, `display`, and `bank-create`)
- Modify: `docs/cli.md`, `docs/bank-maintenance.md`
- Test: `tests/cli.test.ts` (append inside `describe('CLI bank selection', …)`)

**Interfaces:**
- Consumes:
  - `pooledBank` (Task 8);
  - `createPooledBank` and `PooledEnrollmentInput` (Task 5);
  - `POOLED_SCORING` (Task 2);
  - `ProbeResult.candidates`, `requests`, and `ModelScore.fit`, `margin` and their cutoffs (Task 4).

- [ ] **Step 1: Write the failing tests**

In `tests/cli.test.ts`, extend the fixtures import:

```ts
import { forceCutoffs, openEnvelopes, syntheticBank, syntheticEnrollment, syntheticPooledBank, syntheticRun } from './fixtures.js';
```

Also add `readFile` to the existing `node:fs/promises` import.

Add below `stubTerminal`:

```ts
/** A chat-completions stream carrying one reply. */
const sse = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
/** Answer successive requests with the low-range synthetic model's training runs. */
function lowRangeEndpoint() {
  let call = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sse(`${syntheticRun(1, 120, call++).join(' ')} `));
}
```

Append inside `describe('CLI bank selection', …)`:

```ts
  it('selects the bundled pooled bank with --pooled', async () => {
    vi.stubEnv('LOGITPING_API_KEY', 'tool-key');
    vi.spyOn(bankLoader, 'pooledBank').mockResolvedValue(openEnvelopes(syntheticPooledBank()));
    const fetch = lowRangeEndpoint();
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--pooled', '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'HEURISTIC_MATCH', model: 'synthetic-1-120', candidates: ['synthetic-1-120'], requests: 4 });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(process.exitCode).toBe(2);
  });

  it('prints the candidates and request count of a pooled result', async () => {
    vi.stubEnv('LOGITPING_API_KEY', 'tool-key');
    vi.spyOn(bankLoader, 'pooledBank').mockResolvedValue(forceCutoffs(openEnvelopes(syntheticPooledBank()), [true, true, false]));
    lowRangeEndpoint();
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--pooled']);
    expect(stdout).toContain('Inconclusive, consistent with: synthetic-1-120, synthetic-118-237');
    expect(stdout).toContain('256/256 integers in 4 requests');
    expect(stdout).toContain('fit pass · margin pass');
    expect(process.exitCode).toBe(2);
  });

  it('rejects --pooled together with --bank before any request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await main(['node', 'lping', '--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--pooled', '--bank', join(directory, 'bank.json'), '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ERROR', error: 'Choose either --pooled or --bank' });
    expect(fetch).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [['--driver', 'codex'], 'transport=codex (bank: openai)'],
    [['--endpoint', 'https://proxy.example/v1', '--model', 'claimed', '--samples', '512'], 'samples=512 (bank: 64)'],
  ])('checks the pooled bank protocol before any request (%#)', async (args, message) => {
    vi.spyOn(bankLoader, 'pooledBank').mockResolvedValue(syntheticPooledBank());
    const fetch = vi.spyOn(globalThis, 'fetch');
    await main(['node', 'lping', ...args, '--pooled', '--no-tokenizer', '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ERROR', code: 'PROTOCOL_MISMATCH', error: expect.stringContaining(message) });
    expect(fetch).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(0);
  });

  it('creates a pooled bank when the enrollment input sets pooled scoring', async () => {
    const input = join(directory, 'enrollment.json');
    const output = join(directory, 'pooled-bank.json');
    await writeFile(input, JSON.stringify({ ...syntheticEnrollment(), scoring: 'pooled-sets-v1', requestsPerProbe: 4 }));
    await main(['node', 'lping', 'bank-create', '--input', input, '--output', output]);
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({ schemaVersion: 2, protocol: { requestsPerProbe: 4, scoring: 'pooled-sets-v1' } });
  });

  it('refuses requestsPerProbe without pooled scoring in enrollment input', async () => {
    const input = join(directory, 'enrollment.json');
    await writeFile(input, JSON.stringify({ ...syntheticEnrollment(), requestsPerProbe: 4 }));
    await main(['node', 'lping', 'bank-create', '--input', input, '--output', join(directory, 'bank.json')]);
    expect(stderr).toContain('Set scoring and requestsPerProbe together');
    expect(process.exitCode).toBe(1);
  });

  it('offers the experimental pooled bank when the interactive bank path is blank', async () => {
    vi.stubEnv('LOGITPING_API_KEY', 'tool-key');
    vi.spyOn(bankLoader, 'pooledBank').mockResolvedValue(openEnvelopes(syntheticPooledBank()));
    const fetch = lowRangeEndpoint();
    prompts.answers.push('api', 'openai', 'https://proxy.example/v1', 'claimed', undefined, true);
    const restore = stubTerminal();
    try { await main(['node', 'lping']); } finally { restore(); }
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(stdout).toContain('Heuristic match: synthetic-1-120');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/vitest run tests/cli.test.ts -t "pooled"`
Expected: FAIL with `error: unknown option '--pooled'`.

- [ ] **Step 3: Implement it in `src/cli.ts`**

1. Update the imports:

```ts
import { loadBank, pooledBank } from './data/bank_loader.js';
import { createPooledBank, type PooledEnrollmentInput } from './data/pooled_enrollment.js';
import { POOLED_SCORING } from './math/pooled_features.js';
import { isRecord, MAX_PAYLOAD_BYTES, MAX_SAMPLES, MIN_SAMPLES } from './util/validate.js';
```

The last line replaces the existing `./util/validate.js` import.
2. Add `pooled?: boolean;` to `interface Options`, after `bank?: string;`.
3. Add the option after the `--bank` option:

```ts
    .option('--pooled', 'use the bundled experimental pooled bank: 8 requests of 64 integers; heuristic matches only')
```

4. In `interactive`, replace `if (bank.trim()) options.bank = bank.trim();` with:

```ts
  if (bank.trim()) options.bank = bank.trim();
  else if (mode === 'api' && !options.allowTransportMismatch) {
    options.pooled = answer(await prompts.select({ message: 'Bundled bank', options: [
      { value: false, label: 'Standard', hint: '1 request of 512 integers' },
      { value: true, label: 'Experimental pooled', hint: '8 requests of 64 integers; heuristic matches only' },
    ] }));
  }
```

5. In the main action, add this immediately after the `if (!options.driver && !options.endpoint) { … }` block. Placing it after the interactive prompts means it also sees what they filled in:

```ts
    if (options.pooled && options.bank) throw new Error('Choose either --pooled or --bank');
```

Replace `const bank = options.bank ? await loadBank(options.bank) : undefined;` with:

```ts
    const bank = options.pooled ? await pooledBank() : options.bank ? await loadBank(options.bank) : undefined;
```

6. In the `bank-create` action, replace `const bank = createFingerprintBank(input as EnrollmentInput);` with:

```ts
      const fields = isRecord(input) ? input : {};
      if (fields.scoring !== undefined && fields.scoring !== POOLED_SCORING) throw new Error(`Enrollment scoring must be ${POOLED_SCORING}`);
      if ((fields.scoring === undefined) !== (fields.requestsPerProbe === undefined)) throw new Error('Set scoring and requestsPerProbe together');
      const bank = fields.scoring === undefined ? createFingerprintBank(input as EnrollmentInput) : createPooledBank(input as PooledEnrollmentInput);
```

7. In `display`, replace the `label` line with:

```ts
  const label = result.status === 'HEURISTIC_MATCH' ? `Heuristic match: ${result.model}`
    : result.candidates && result.candidates.length > 1 ? `Inconclusive, consistent with: ${result.candidates.join(', ')}`
      : result.model ?? result.status;
```

Replace the score line inside the loop with:

```ts
    const sets = score.fit === undefined ? ''
      : ` · fit ${score.fit >= score.fitCutoff! ? 'pass' : 'fail'} · margin ${score.margin! >= score.marginCutoff! ? 'pass' : 'fail'}`;
    process.stdout.write(`  ${score.id}: ${score.weight === null ? 'unranked' : `${(score.weight * 100).toFixed(2)}%`} · H=${score.hellinger.toFixed(4)} · M=${score.mahalanobis.toFixed(2)} · OOD ${score.accepted ? 'pass' : 'reject'}${sets}\n`);
```

Replace the integers line with:

```ts
  process.stdout.write(`${result.samples.length}/${result.requestedSamples} integers${result.requests ? ` in ${result.requests} requests` : ''} · ${result.elapsedMs} ms\n`);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run tests/cli.test.ts`
Expected: all CLI tests pass, 8 more than before.

- [ ] **Step 5: Document `--pooled` in `docs/cli.md`**

Add after the `--max-tokens` paragraph:

```markdown
`--pooled` selects the bundled **experimental pooled bank**: each probe sends 8 requests of 64 integers through the same connection and scores them together as a prediction set ([methodology](methodology.md#experimental-pooled-probe-pooled-sets-v1)). It costs about 0.72× a 512-integer probe but takes 8 round trips. The bank was collected with 4,096 output tokens per request; pass `--max-tokens 4096` for reasoning models.

- A single-model set prints `Heuristic match: <model>` and exits with 2. An unenrolled model from the same vendor as an enrolled one can produce it.
- A larger set prints `Inconclusive, consistent with: <models>`.
- An empty set is `UNKNOWN_MODEL`.

JSON adds `candidates` and `requests`. A reply shorter than 64 integers ends the probe as `INCONCLUSIVE` and names the request. `--pooled` cannot be combined with `--bank`; a custom pooled bank is recognized from its protocol. Like any explicit API bank, it refuses `--driver claude|codex` unless `--allow-transport-mismatch` is given. In interactive mode, an API connection with a blank bank path offers the choice.
```

- [ ] **Step 6: Document pooled enrollment input**

Append to the "Pooled banks (experimental)" section of `docs/bank-maintenance.md`:

```markdown
`lping bank-create` builds a pooled bank from independently collected runs when its input adds `"scoring": "pooled-sets-v1"` and `"requestsPerProbe"` to the usual enrollment fields. A pooled bank needs at least two models, each with at least three training and two held-out runs.
```

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts docs/cli.md docs/bank-maintenance.md tests/cli.test.ts
git commit -m "feat: add --pooled to the CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Check the implementation against the evidence

**Files:**
- Create: `scripts/research/check-pooled.mjs`
- Modify: `scripts/research/README.md` (record the result)

**Interfaces:**
- Consumes: the built `dist/index.js` (`createPooledBank` and `fingerprint`), plus the research corpus.

- [ ] **Step 1: Write `scripts/research/check-pooled.mjs`**

```js
// Compare the production pooled scoring with the frozen prototype (see README.md):
// 1. bank distributions and pair scores against the prototype's arithmetic on the full corpus (limit 1e-9);
// 2. leave-group-out results at k = 8 against the gate test, C4 gated (45/65, 1/65, 9/65; ±2 units).
// Usage: npm run build && node scripts/research/check-pooled.mjs <research-64 corpus.json>
import { readFileSync } from 'node:fs';
import { createPooledBank, fingerprint } from '../../dist/index.js';

const corpus = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const K = 8;
const N = 355;
const SMOOTH = 0.5;
// Copied verbatim from prototype.mjs.
const FAMILIES = [
  ['value', N, (r) => r.map((x) => x - 1)],
  ['step', N, (r) => r.slice(1).map((x, i) => (x - r[i] + N) % N)],
  ['bin bigram', 400, (r) => r.slice(1).map((x, i) => Math.floor((r[i] - 1) / 17.75) * 20 + Math.floor((x - 1) / 17.75))],
  ['digit bigram', 100, (r) => r.slice(1).map((x, i) => (r[i] % 10) * 10 + (x % 10))],
  ['first use', N * 4, (r) => { const seen = new Set(), out = []; r.forEach((x, t) => { if (!seen.has(x)) { seen.add(x); out.push((x - 1) * 4 + Math.min(3, Math.floor(t / 89))); } }); return out; }],
  ['opening 8', N * 8, (r) => r.slice(0, 8).map((x, t) => t * N + x - 1)],
  ['repeat gap', 12, (r) => { const last = new Map(), out = []; r.forEach((x, t) => { const g = last.has(x) ? t - last.get(x) : -1; out.push(g < 0 ? 0 : Math.min(11, 1 + Math.floor(Math.log2(g)))); last.set(x, t); }); return out; }],
].map(([name, size, ev]) => ({ name, size, ev }));
const meanOf = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const runsOf = (model) => [...model.training, ...model.validation];
const ids = corpus.models.map((model) => model.id);
const enroll = (models) => createPooledBank({ source: 'equivalence check', protocol: corpus.protocol, checkpoints: corpus.checkpoints, requestsPerProbe: K, models });

// Part 1: arithmetic on the full corpus.
const bank = enroll(corpus.models);
const counted = corpus.models.map((model) => runsOf(model).map((run) => FAMILIES.map(({ ev }) => {
  const map = new Map(); let total = 0;
  for (const e of ev(run)) { map.set(e, (map.get(e) ?? 0) + 1); total++; }
  return { map, total };
})));
const totals = counted.map((runs) => FAMILIES.map(({ size }, f) => {
  const c = new Float64Array(size); let total = 0;
  for (const run of runs) { for (const [e, n] of run[f].map) c[e] += n; total += run[f].total; }
  return { c, total };
}));
let worst = 0;
const compare = (actual, expected) => { worst = Math.max(worst, Math.abs(actual - expected) / Math.max(1, Math.abs(expected))); };
totals.forEach((families, m) => families.forEach(({ c, total }, f) => c.forEach((count, e) =>
  compare(bank.pooled.models[m].families[f][e], (count + SMOOTH) / (total + SMOOTH * FAMILIES[f].size)))));
// The prototype's leave-own-run-out log-likelihoods (its BASE table).
const loglik = (run, a, m, f) => {
  const { c, total } = totals[m][f];
  const own = m === a ? run[f] : { map: new Map(), total: 0 };
  const logDenom = Math.log(total - own.total + SMOOTH * FAMILIES[f].size);
  let s = 0;
  for (const [e, k] of run[f].map) s += k * (Math.log(c[e] - (own.map.get(e) ?? 0) + SMOOTH) - logDenom);
  return s;
};
const X = counted.map((runs, a) => runs.map((run) => counted.map((_, m) => FAMILIES.map((__, f) => loglik(run, a, m, f)))));
// The prototype's pairStat over ratio rows.
function pairStat(xa, xb) {
  const w = xa[0].map((_, j) => {
    const ma = meanOf(xa.map((row) => row[j])), mb = meanOf(xb.map((row) => row[j]));
    const v = (xa.reduce((s, row) => s + (row[j] - ma) ** 2, 0) + xb.reduce((s, row) => s + (row[j] - mb) ** 2, 0)) / (xa.length + xb.length - 2);
    return v > 0 && ma > mb ? (ma - mb) / v : 0;
  });
  if (w.every((x) => x === 0)) w.fill(1);
  const D = (row) => row.reduce((s, x, j) => s + w[j] * x, 0);
  const da = xa.map(D), db = xb.map(D);
  const ma = meanOf(da), mb = meanOf(db);
  const V = (da.reduce((s, x) => s + (x - ma) ** 2, 0) + db.reduce((s, x) => s + (x - mb) ** 2, 0)) / (da.length + db.length - 2);
  const sd = Math.sqrt(Math.max(V, 1e-12));
  return (row) => (D(row) - (ma + mb) / 2) / sd;
}
for (const pair of bank.pooled.pairs) {
  const m = ids.indexOf(pair.model), o = ids.indexOf(pair.competitor);
  const rows = (a) => X[a].map((run) => run[m].map((value, f) => value - run[o][f]));
  const prototype = pairStat(rows(m), rows(o));
  for (const row of [...rows(m), ...rows(o)]) compare((row.reduce((s, x, f) => s + pair.weights[f] * x, 0) - pair.center) / pair.scale, prototype(row));
}
console.log(`Largest relative difference from the prototype: ${worst.toExponential(2)} (limit 1e-9)`);

// Part 2: leave-group-out at k = 8, grouped as the prototype harness groups runs.
async function probe(fitted, responses) {
  let index = 0;
  const transport = { name: 'openai', granularity: 'token', async *stream() { yield `${responses[index++].join(' ')} `; } };
  return fingerprint(transport, { bank: fitted, earlyStopping: false });
}
const tally = { correct: 0, wrong: 0, unenrolledWrong: 0, units: 0 };
for (const [t, model] of corpus.models.entries()) {
  const runs = runsOf(model);
  const groups = Math.round(runs.length / K);
  const unenrolled = enroll(corpus.models.filter((_, mi) => mi !== t));
  for (let g = 0; g < groups; g++) {
    const held = new Set(runs.map((_, i) => i).filter((i) => i % groups === g));
    const fitted = enroll(corpus.models.map((m, mi) => mi !== t ? m : {
      ...m,
      training: m.training.filter((_, i) => !held.has(i)),
      validation: m.validation.filter((_, i) => !held.has(i + m.training.length)),
    }));
    const responses = [...held].map((i) => runs[i]);
    const enrolled = await probe(fitted, responses);
    if (enrolled.candidates?.length === 1) enrolled.candidates[0] === model.id ? tally.correct++ : tally.wrong++;
    const outside = await probe(unenrolled, responses);
    if (outside.candidates?.length === 1) tally.unenrolledWrong++;
    tally.units++;
  }
}
const rows = [['Correct single model, enrolled', tally.correct, 45], ['Wrong single model, enrolled', tally.wrong, 1], ['Unenrolled model named', tally.unenrolledWrong, 9]];
for (const [label, value, target] of rows) console.log(`${label}: ${value}/${tally.units} (gate test ${target}/65) ${Math.abs(value - target) <= 2 ? 'ok' : 'OUT OF RANGE'}`);
if (worst > 1e-9 || tally.units !== 65 || rows.some(([, value, target]) => Math.abs(value - target) > 2)) process.exitCode = 1;
```

- [ ] **Step 2: Build and run it**

```bash
node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run build
node scripts/research/check-pooled.mjs research-64.local.json.corpus-4d34afe7497e9d0d83238136885022a808a5c0e6ecfcfc32b7ed5689131f0bbf.json; echo "exit $?"
```

Expected:
- The script prints `Largest relative difference …` below `1e-9`, and three `ok` lines over `/65`.
- It ends with `exit 0`.
- If a line is out of range, stop and report it. Do not adjust the targets. A mismatch means the port differs from the prototype; find the step in spec "Enrollment" that the code does not follow.

- [ ] **Step 3: Record the result in `scripts/research/README.md`**

Append this, filling in the printed values:

```markdown
## Implementation check

`check-pooled.mjs` compares the production `createPooledBank` and engine with the prototype on `research-64.local.json.corpus-4d34afe7….json`:

- **Arithmetic:** largest relative difference <printed value>, against a limit of 1e-9.
- **Leave-group-out at 8 requests**, gate test C4 gated in parentheses:
  - correct single model <n>/65 (45/65);
  - wrong single model <n>/65 (1/65);
  - unenrolled model named <n>/65 (9/65).

Exact equality is not expected, because the bootstrap draws in a different order.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/research/check-pooled.mjs scripts/research/README.md
git commit -m "test: check pooled scoring against the prototype evidence

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Documentation and final verification

**Files:**
- Modify: `README.md`, `docs/methodology.md`, `docs/bank.md`, `CHANGELOG.md`

- [ ] **Step 1: `docs/methodology.md`, appended at the end**

```markdown
## Experimental pooled probe (`pooled-sets-v1`)

Some models answer the 512-integer probe with near-permutations, which use almost every value once. Their value histograms then carry little information: `gpt-6.1-sol` and its teacher `gpt-6-astra` were `INCONCLUSIVE` on every evaluated run. A pooled bank instead asks for several short replies, 8 requests of 64 integers, and scores what is left free in short replies: which values come first, which follow which, and when values recur.

**Features.** Each reply contributes events to seven groups:

| Group | What is counted |
| --- | --- |
| Value | each value |
| Step | the difference between consecutive values, modulo 355 |
| Value-bin pair | consecutive values, in 20 bins of 17.75 values |
| Last-digit pair | the last digits of consecutive values |
| First use | each value's first appearance, by quarter of a 355-position run |
| Opening | the value at each of the first 8 positions |
| Repeat gap | positions since the value last appeared, in log2 bins |

Each enrolled model has a Jeffreys-smoothed distribution per group.

**Prediction set.** For each model, the replies give two scores:

- a fit: the summed log-likelihood;
- a margin: the worst standardized head-to-head score against any other model, summed over replies and divided by √8.

The head-to-head score weights the per-group log-likelihood ratios. It uses diagonal linear discriminant weights, clipped at zero, fitted for that pair of models.

A model stays in the set when three things hold:

- both scores reach that model's cutoffs;
- its 64-integer distance envelope accepts every reply;
- every request returned 64 integers. If any request is short, the probe is `INCONCLUSIVE` before scoring.

**Calibration.** Cutoffs are per model, with conformal miscoverage α = 0.2 split between the two tests.

- Enrollment scores each of the model's runs with statistics fitted without that run (cross-fitting).
- It then draws 2,000 seeded tuples of 8 runs, and sets each cutoff at the 10% conformal quantile of those draws.
- The seed is recorded in the bank, so enrollment is repeatable.

**Results.**

| Set | Result |
| --- | --- |
| One model | `HEURISTIC_MATCH` |
| Several models | `INCONCLUSIVE`, listing the `candidates` |
| None | `UNKNOWN_MODEL` |

**Limits.**

- The set is calibrated for enrolled models.
- An unenrolled model is often named as its closest enrolled relative from the same vendor, sometimes from another generation. The envelope gate removes few of these.
- See [bank status](bank.md#experimental-pooled-bank) for the measured rates.
- Early stopping is not available in pooled mode.
```

- [ ] **Step 2: `docs/bank.md`, appended at the end**

```markdown
## Experimental pooled bank

`--pooled` (library: `pooledBank()`) uses a second bundled bank, `src/data/pooled_bank.json`. It covers the same 13 models, collected through OpenRouter on 2026-10-11 without streaming: 25 training and 15 held-out runs of 64 English integers per model, with 4,096 output tokens per request. Its provenance records the corpus SHA-256, `4d34afe7497e9d0d83238136885022a808a5c0e6ecfcfc32b7ed5689131f0bbf`. Each probe sends 8 requests; see [methodology](methodology.md#experimental-pooled-probe-pooled-sets-v1).

Exploratory leave-group-out results on that collection. "Unenrolled" means the model was removed from the bank and its runs probed against the rest.

| Probe | Enrolled model named wrongly | Unenrolled model named | `gpt-6.1-sol` / `gpt-6-astra` named correctly |
| --- | --- | --- | --- |
| 1 × 512 integers, default engine (fresh 512-integer collection) | 0/519 | 51/519 (10%) | 0/80 |
| 8 × 64 integers, pooled bank | 1/65 | 9/65 (14%) | 6/10 |

Treat these as exploratory:

- The pooled test was designed after the collection results were seen.
- The 8-request samples are small: 9/65 has a 95% interval of about 7–24%.
- The pooled mode did not meet the predeclared target of naming unenrolled models at most 10% of the time.
- Unenrolled models were named as close relatives from the same vendor. In the pooled test, none was named as a model from another vendor.

The mode is therefore opt-in, and a single-model result is a `HEURISTIC_MATCH`.
```

- [ ] **Step 3: `README.md`**

Add a section after the Quickstart's JSON excerpt and its explanation, before the next `##` heading:

```markdown
### Experimental: pooled short requests

`--pooled` sends 8 requests of 64 integers instead of one of 512. It costs about 0.72× as much, and it separates closely related models better: on the 2026-10-11 collection, it named `gpt-6.1-sol` or its teacher `gpt-6-astra` correctly in 6 of 10 probes, where the default probe was inconclusive in every run. A single-model result is a `HEURISTIC_MATCH` (exit code 2), because an unenrolled model from the same vendor can produce it. **Each probe sends 8 provider requests.** See [bank status](docs/bank.md#experimental-pooled-bank).

    lping --endpoint https://openrouter.ai/api/v1 --model openai/gpt-6.1-sol --api-format responses --max-tokens 4096 --pooled --json
```

- [ ] **Step 4: `CHANGELOG.md`**

Under `## Unreleased`, add an `### Added` section before `### Changed`:

```markdown
### Added

- Experimental pooled probe (`--pooled`; library: `pooledBank()`):
  - Each probe sends 8 requests of 64 integers and scores them together as a calibrated prediction set over seven feature groups, with each model's distance envelope applied to every reply.
  - A single-model set returns `HEURISTIC_MATCH`, several return `INCONCLUSIVE` with `candidates`, and none returns `UNKNOWN_MODEL`.
  - The bundled pooled bank covers the 13 reference models, collected on 2026-10-11 (25 training and 15 held-out runs each).
  - See the README for its measured rates and limits.
- Pooled banks use bank schema version 2, which logitping 0.1.0 rejects:
  - `createPooledBank()` builds one from enrollment runs;
  - the bank updater fits one when its configuration sets `"scoring": "pooled-sets-v1"` and `"requestsPerProbe"`;
  - `npm run bank:pooled` adds pooled scoring to a collected bank from its archived corpus.
  - Incremental updates are refused for pooled banks.
- `ProbeResult.candidates` and `ProbeResult.requests`, and the pooled `fit`, `margin` and cutoff fields in `scores`.
```

- [ ] **Step 5: Run every check**

```bash
node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run check
node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run test:package
node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js pack --dry-run --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const [p]=JSON.parse(s);console.log("unpacked",p.unpackedSize,"files",p.entryCount)})'
node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js view logitping@0.1.0 dist.unpackedSize
git diff main --stat -- src/data/default_bank.json
```

Expected:
- `check` passes: typecheck, all tests and the build.
- `test:package` prints its success line.
- Report the unpacked size against 0.1.0's. The spec estimates about 5 MB of growth.
- The last command prints nothing, because the default bank is unchanged.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/methodology.md docs/bank.md CHANGELOG.md
git commit -m "docs: document the experimental pooled probe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
