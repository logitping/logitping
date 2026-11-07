# Pooled-probe research scripts

Offline scripts behind `specs/2026-10-11-pooled-probe-design.md`. They read local corpora only and make no provider requests. Build first (`npm run build`), because they import `../../dist/index.js`.

| Script | Purpose |
|---|---|
| `prototype.mjs` | The prototype frozen before the 2026-10-11 collection: conformal prediction sets C1–C5 over seven feature groups. |
| `prototype-eval.mjs` | `prototype.mjs` plus harness options: `KS` (requests per unit), `DROP_LOOPS`, and the unenrolled (leave-one-model-out) refit. |
| `gate-test.mjs` | Exploratory follow-up: C1 and C4 with each model's per-response OOD envelope in front of the set, against the current engine pooled over the same requests. |
| `check-pooled.mjs` | Checks the production implementation against the prototype; see Task 10 of the plan. |
| `pooled-eval.mjs` | Evaluates pooled scoring with the production engine: leave-group-out, or a fixed bank against runs from a separate collection, over 10 groupings. Gives the counts in [bank status](../../docs/bank.md#experimental-pooled-bank). |

`prototype.mjs` was frozen with SHA-256 `2964649026827d4774b2331b8a70c55b85a9eb3b2e4e7552166acdb40fffed24`. The only change since is its import line: an absolute local path became `'../../dist/index.js'`. Its SHA-256 is now `e28a621b8553f222821f5d159af0ad267ff75816d0a30afc5e9b60193b33ebfd`.

`prototype.mjs` and `prototype-eval.mjs` keep the original loop rule (any period up to 128). On 64-integer runs it wrongly flags a run whose first and last values match: one `gpt-6.1-sol` run with `DROP_LOOPS=1`. `gate-test.mjs` and the bank updater cap the period at a quarter of the run.

The corpora are git-ignored and stay at the repository root:

- `research-512.local.json.corpus-73559ea6….json`: 13 models × 40 runs × 512 integers.
- `research-64.local.json.corpus-4d34afe7….json`: 13 models × 40 runs × 64 integers.
- `pooled-openai.local.json.corpus-5472cb6f….json`: 8 GPT models × 40 runs × 64 integers.
- `pair-heldout.local.json.corpus-bbd00932….json`: `gpt-6.1-sol` and `gpt-6-astra` × 40 runs × 64 integers.

The first two were collected through OpenRouter on 2026-10-11. The other two came directly from OpenAI, on 2026-11-06 and 2026-11-07.

Example: `KS=4,8 node scripts/research/gate-test.mjs research-64.local.json.corpus-4d34afe7497e9d0d83238136885022a808a5c0e6ecfcfc32b7ed5689131f0bbf.json`

## Pooled evaluation

Run `npm run build` first; `pooled-eval.mjs` writes JSON to stdout. The earlier 13-model bank is at commit `bb30c2a`: `git show bb30c2a:src/data/pooled_bank.json > earlier-pooled-bank.local.json`.

| Test | Arguments |
|---|---|
| Earlier bank, leave-group-out | `research-64.local.json.corpus-4d34….json` |
| Current bank, leave-group-out | `pooled-openai.local.json.corpus-5472….json research-64.local.json.corpus-4d34….json` |
| 2026-10-11 runs against the current bank | `research-64.local.json.corpus-4d34….json --bank src/data/pooled_bank.json` |
| 2026-11-06 runs against the earlier bank | `pooled-openai.local.json.corpus-5472….json --bank earlier-pooled-bank.local.json` |
| Held-out pair runs against each bank | `pair-heldout.local.json.corpus-bbd0….json --bank src/data/pooled_bank.json`, then `--bank earlier-pooled-bank.local.json` |

In the second row the OpenAI corpus comes first, so it supplies the GPT runs and the 2026-10-11 corpus supplies only the Claude runs, in the current bank's model order.

On 2026-11-07 the first row reproduced the published 45/65, 1/65, 9/65 and 6/10 exactly. An earlier script produced the bank notes' repeated groupings and was not kept, so those counts changed slightly when rerun with this script's random partitions.

## Held-out test of `gpt-6.1-sol` and `gpt-6-astra`

This plan was committed on 2026-11-07 in `0f2e4ce`, before these runs were collected. Leave-group-out on the current bank named this pair correctly in 2/10 probes, down from 6/10 on the earlier bank, but those runs also built the banks. This test scores both banks on runs that neither was fitted from.

- **Collection:** [`pair-heldout-collection.json`](pair-heldout-collection.json) requests 40 runs of 64 integers per model directly from OpenAI, under the current bank's settings, with a hard cap of 80 requests.
- **Banks:** both unchanged: `src/data/pooled_bank.json` as of this commit, and the earlier bank at `bb30c2a`.
- **Measure:** `pooled-eval.mjs <new corpus> --bank <bank>` for each bank. The main counts are correct and wrong single-model results over 10 groupings: 100 probes built from the same 80 runs. The first grouping, 10 probes, is reported alongside them.
- **A bank separates the pair** if it names it correctly in at least 50/100 probes, the existing target, with at most 20/100 wrong. The 20 is a judgment: leave-group-out gave 11/100 on the earlier bank and 30/100 on the current one.
- **Recommendation rule:**
  - Go back to the earlier bank only if it separates the pair, the current bank does not, and it has at least 20 more correct results.
  - Otherwise keep the current bank, which also enrolls `gpt-6.1-terra`.
  - If neither bank separates the pair, document that `--pooled` does not reliably tell these two models apart.

Limits, known in advance:

- The test favors the current bank. The new runs use the same route as its references and come a day later; the earlier bank's references came through OpenRouter about four weeks earlier.
- It says nothing about probes sent through OpenRouter.
- 80 runs is a small sample, and the 10 groupings reuse them.

### Outcome

The collection ran on 2026-11-07: 80 runs from 80 requests, with no retries. Every run has 64 integers in range, and none repeats a run from an earlier collection.

| Bank | Correct | Wrong | Several candidates | No candidate | Correct, first grouping |
|---|---|---|---|---|---|
| Current | 15/100 | 25/100 | 48/100 | 12/100 | 2/10 |
| Earlier | 16/100 | 40/100 | 27/100 | 17/100 | 1/10 |

Neither bank separates the pair. Following the rule, the current bank was kept, and the docs say that `--pooled` does not reliably tell these two models apart.

## Implementation check

`check-pooled.mjs` compares the production `createPooledBank` and engine with the prototype on `research-64.local.json.corpus-4d34afe7….json`:

- **Arithmetic:** largest relative difference 0, against a limit of 1e-9.
- **Leave-group-out at 8 requests**, gate test C4 gated in parentheses:
  - correct single model 45/65 (45/65);
  - wrong single model 1/65 (1/65);
  - unenrolled model named 9/65 (9/65).

Exact equality is not guaranteed, because the bootstrap draws in a different order; on this corpus the results coincide. The check runs in about 15 s.
