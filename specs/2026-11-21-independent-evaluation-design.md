# Independent evaluation report: design

Status: agreed in conversation on 2026-11-21, as item 1 of the 0.8.0 plan.

## Context

The documentation reports only in-sample diagnostics for the default bank. `docs/bank.md` says "There is no published independent estimate of real-model identification accuracy, unknown-model error rates, or latency savings", and that default-bank probes through OpenRouter against the direct GPT references "have not been evaluated". The README still cites the 65-run replay of the `0.1.0` bank.

The stored corpora already hold runs that the bundled banks were not built from:

- runs of enrolled models from other collections, such as the 2026-10-11 OpenRouter `research-512` corpus and the superseded OpenRouter GPT runs of 2026-10-03;
- runs of the four models removed in `0.7.0`, which neither bank enrolls.

An offline review on 2026-11-21 scored them with the production engine. The default bank's distance envelopes rejected only 2 of 225 runs of never-enrolled models, while the README describes `UNKNOWN_MODEL` without saying how rare it is.

This work turns that review into a maintained command whose output is committed with each bank, and corrects the documentation. Item 3 of the plan (candidates and equivalence classes) will be judged against this report.

## Decisions

| Topic | Decision |
| --- | --- |
| Command | `npm run bank:evaluate`: build, then `node scripts/evaluate-banks.mjs`. No arguments. |
| Inputs | Every file matching `*.corpus-<64 hex>.json` in the repository root and in `src/data/`, plus `src/data/default_bank.json` and `src/data/pooled_bank.json`. |
| Corpus identity | `corpusDigest(corpus)` over the file content, never the file name. A digest already read is skipped, so a copied corpus counts once. |
| Role of each corpus model, per bank | **Own:** the bank enrolls the id and its provenance contains `corpus sha256:<digest>;`; skipped. **Independent:** the bank enrolls the id and its provenance names another corpus. **Never enrolled:** the bank does not enroll the id. |
| Routing | A corpus is scored by each bank whose protocol matches it on `id`, `language`, `targetSamples`, `temperature` and `transport` (`sameProtocol`). A corpus matching neither bank is an error. |
| Default-bank tests | One probe per run, `earlyStopping: false`, through the production `fingerprint()`. **Enrolled:** independent runs against the full bank. **Label removed:** the same runs against the bank without that model; v1 models are fitted separately, so dropping one needs no refit. **Never enrolled:** runs against the full bank. |
| Pooled-bank tests | Against the fixed bundled pooled bank. **Enrolled:** independent runs. **Never enrolled:** runs of models it does not enroll. A probe is one group of `requestsPerProbe` runs from one model in one corpus. 10 groupings, partitioned exactly as `scripts/research/pooled-eval.mjs` does. A label-removed pooled test needs a refit and stays in `pooled-eval.mjs`. |
| Engine | Unchanged. A replay transport named `openai` answers request *i* with run *i*. |
| Output | `docs/evaluation.json` (the report) and `docs/evaluation.md` (rendered from the JSON by `renderEvaluationReport`). Both are committed and deterministic: no timestamps, and no paths except the two repo-relative bank names. Corpora appear only by SHA-256. |
| Bank versioning | The report records the SHA-256 of each bank file's UTF-8 text. `tests/evaluation-report.test.ts` fails when either digest differs, or when the markdown differs from rendering the JSON. |
| Code location | `src/data/evaluation.ts`, exported from `src/maintainer.ts`. Not part of the public library. |
| Failure | With no corpora, or an invalid one, the script exits 1 and leaves both report files unchanged. |

## Report format (`schemaVersion: 1`)

```ts
interface EvaluationReport {
  schemaVersion: 1;
  banks: { default: BankSummary; pooled: BankSummary };
  corpora: CorpusSummary[];          // sorted by collectedAt, then sha256
  default: DefaultResults;
  pooled: PooledResults;
}
interface BankSummary { file: string; sha256: string; models: number }
interface CorpusSummary { sha256: string; collectedAt: string; targetSamples: number; models: string[] }
interface DefaultResults { enrolled: CorpusTallies<StatusTally>[]; labelRemoved: CorpusTallies<StatusTally>[]; neverEnrolled: CorpusTallies<StatusTally>[] }
interface PooledResults { groupings: number; requestsPerProbe: number; enrolled: CorpusTallies<SetTally>[]; neverEnrolled: CorpusTallies<SetTally>[] }
interface CorpusTallies<T> { corpus: string; models: Record<string, T> }   // corpus = sha256
interface StatusTally { runs: number; correct: number; wrong: Record<string, number>; inconclusive: number; unknown: number }
interface SetTally { probes: number; correct: number; wrong: Record<string, number>; several: number; none: number; stopped: number }
```

- `wrong` maps the named model to a count.
- `stopped` counts pooled probes the engine ended before scoring, because a reply repeated an earlier one.
- An entry exists only for a corpus with at least one model in that role, and a model only with at least one run or probe. Order follows the corpora, then each corpus's model order.

## Expected results on the current corpora

The command must reproduce the offline review and the counts already published for the pooled bank. A mismatch is a defect to investigate, not a number to publish.

**Default bank:**

| Test | Runs | Correct | Wrong | `INCONCLUSIVE` | `UNKNOWN_MODEL` |
| --- | --- | --- | --- | --- | --- |
| Enrolled | 460 | 152 | 0 | 303 | 5 |
| Label removed | 460 | 0 | 18, all between `claude-fable-5` and `claude-fable-5.1` | 413 | 29, all `claude-sonnet-5` |
| Never enrolled | 225 | 0 | 0 | 223 | 2 |

- The enrolled runs come from corpus `73559ea6…` (400 runs) and `163709a6…` (60 runs).
- `gpt-6-luna` is correct in 55 of 55, `gpt-6-sol` in 4 of 55, and `gpt-6.1-sol` and `gpt-6-astra` in 0 of 110.

**Pooled bank:**

| Test | Corpus | Result |
| --- | --- | --- |
| Enrolled | `4d34afe7…`, `gpt-6-sol` + `gpt-6-luna` | 87 of 100 correct, 0 wrong |
| Enrolled | `4d34afe7…`, `gpt-6.1-sol` + `gpt-6-astra` | 14 of 100 correct, 17 wrong |
| Enrolled | `bbd00932…`, `gpt-6.1-sol` + `gpt-6-astra` | 15 correct, 25 wrong, 48 several, 12 none |
| Never enrolled | `4d34afe7…` | `gpt-5.6-luna` named 1, `gpt-5.6-terra` 3, `gpt-5.6-sol` 9 (of 50 each) |
| Never enrolled | `5472cb6f…` | `gpt-5.6-luna` named 14, `gpt-5.6-terra` 21, `gpt-5.6-sol` 3 (of 50 each) |
| Never enrolled | `be70762f…` | `gemini-3.8-flash` named 0 of 50 |

Never-enrolled totals: 51 of 350 probes named a model (`gpt-6-sol` 41, `gpt-6.1-terra` 10), 299 none, 0 several, 0 stopped.

## Documentation changes

The copy below is fixed. Numbers come from the generated report and must equal the expected results above.

**`README.md`: the `UNKNOWN_MODEL` row of "Understand the result":**

> | `UNKNOWN_MODEL` | All enrolled distance regions rejected the observation; drift can also cause this. This is rare: an unenrolled model usually returns `INCONCLUSIVE` | `2` |

**`README.md`: replace the paragraph that begins "A local replay of 65 threshold-calibration runs" with:**

> On 460 stored runs of 10 enrolled models from collections the bundled bank was not built from, it named 152 correctly and none wrongly; 303 were `INCONCLUSIVE` and 5 `UNKNOWN_MODEL`. With the tested model removed from the bank, 18 runs were named as another model, all between `claude-fable-5` and `claude-fable-5.1`. Of 225 runs of four models the bank never enrolled, none was named and only 2 were rejected as `UNKNOWN_MODEL`, so an `INCONCLUSIVE` result does not show that the endpoint runs an enrolled model. **The 460 runs came through OpenRouter, eight days to five weeks from their references; this is not an accuracy estimate for arbitrary endpoints.** See the [evaluation report](docs/evaluation.md) and the [evaluation notes](docs/bank.md#evaluation-status).

**`docs/bank.md`: replace the first paragraph under "## Evaluation status" with:**

> The [evaluation report](evaluation.md), generated by `npm run bank:evaluate`, scores the bundled banks on every stored run they were not built from, without provider requests. For the default bank, these are 460 runs of 10 enrolled models, collected through OpenRouter on 2026-10-03 and 2026-10-11, and 225 runs of the four models removed in `0.7.0`:
>
> | Default bank, 512 integers | Runs | Named correctly | Named wrongly | `INCONCLUSIVE` | `UNKNOWN_MODEL` |
> | --- | --- | --- | --- | --- | --- |
> | Enrolled models | 460 | 152 | 0 | 303 | 5 |
> | Same runs, tested model removed | 460 | Not applicable | 18 | 413 | 29 |
> | Models never enrolled | 225 | Not applicable | 0 | 223 | 2 |
>
> - The GPT runs test references across provider and date, because the references came directly from OpenAI on 2026-11-06. `gpt-6-luna` was named correctly in all 55 of its runs, `gpt-6-sol` in 4 of 55, and `gpt-6.1-sol` and `gpt-6-astra` in none of 110.
> - The 18 wrong names with the tested model removed were all between `claude-fable-5` and `claude-fable-5.1`.
> - The distance envelopes rarely reject a run. All 29 rejections with the tested model removed were `claude-sonnet-5` runs, and only 2 of 225 runs of never-enrolled models were rejected. An unenrolled model therefore usually returns `INCONCLUSIVE`, like an enrolled model the bank cannot separate from its neighbors.
>
> This is still not an estimate for arbitrary endpoints: the runs share providers with the references, cover 10 of the 18 models, and were not streamed. There is no estimate of latency savings. Keep early stopping disabled until independent sequential evaluation supports enabling it.
>
> The replays below reuse each model's own threshold-calibration runs. They show where errors concentrate, not how often they occur.

**`docs/bank.md`: in the paragraph that begins "The `0.5.0` and `0.6.0` banks and the 21- and 22-model banks", replace its last sentence** ("This has been measured only for the pooled bank; default-bank probes through OpenRouter against the direct GPT references have not been evaluated.") **with:**

> For the default bank, the same kind of test is in [Evaluation status](#evaluation-status).

**`docs/bank.md`: insert this paragraph directly after that one:**

> The four models removed in `0.7.0` give an open-set test that no pooled bank was fitted to: 350 probes from their stored runs, 50 per model and collection. The current bank named a model in 51 of them, always a GPT model, `gpt-6-sol` in 41 and `gpt-6.1-terra` in 10, and returned no candidate in the other 299. The rate depends on the collection: `gpt-5.6-terra` was named in 3 of 50 probes of the 2026-10-11 OpenRouter runs and in 21 of 50 of the 2026-11-06 OpenAI runs. `gemini-3.8-flash` was never named. See the [evaluation report](evaluation.md).

**`docs/methodology.md`: append to the paragraph that begins "OOD rejection requires":**

> In the [independent evaluation](evaluation.md), the envelopes rejected only 2 of 225 runs of models the bundled bank never enrolled; most unenrolled models return `INCONCLUSIVE`, not `UNKNOWN_MODEL`.

**`docs/bank-maintenance.md`: add a final section:**

> ## Evaluate the bundled banks
>
> After any change to `src/data/default_bank.json` or `src/data/pooled_bank.json`, run:
>
>     npm run bank:evaluate
>
> It builds, reads every stored corpus (`*.corpus-*.json` in the repository root and `src/data/`), and scores both bundled banks on every run they were not built from: runs of enrolled models from other collections, the same runs with the tested model removed (default bank only), and runs of models the bank does not enroll. Corpora are identified by their content digest, so a copy of a corpus is read once. It makes no provider requests. It rewrites `docs/evaluation.json` and `docs/evaluation.md`; commit both with the bank. `tests/evaluation-report.test.ts` fails when either bank's SHA-256 differs from the report's, or when the markdown no longer matches the JSON. Then update the summary numbers in `README.md`, `docs/bank.md` and `docs/methodology.md` from the new report.
>
> The report covers only the corpora present in the checkout, so review its diff: a missing corpus removes its rows instead of failing.

**`CHANGELOG.md`: add above `## 0.7.0`:**

> ## Unreleased
>
> ### Added
>
> - `npm run bank:evaluate` (`scripts/evaluate-banks.mjs`) scores both bundled banks on every stored run they were not built from, without provider requests, and writes `docs/evaluation.json` and `docs/evaluation.md`. A test checks that the committed report matches the bundled banks.
>
> ### Documentation
>
> - The README, bank status and methodology now report the first independent results for the default bank: on 460 runs of 10 enrolled models from other collections, 152 named correctly, none wrongly, and 303 `INCONCLUSIVE`. They also state that its distance envelopes rarely reject unenrolled models, which rejected 2 of 225 runs of four never-enrolled models.

## Out of scope

- A pooled label-removed test (it needs a refit; `scripts/research/pooled-eval.mjs` covers it).
- Candidates and equivalence classes (item 3).
- Trimming the per-release history in `docs/bank.md`.
- Publishing the corpora.
- Any change to the engine or either bank.
