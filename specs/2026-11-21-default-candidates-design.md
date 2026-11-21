# Candidate lists for single-request probes: design

Status: drafted on 2026-11-21 as item 3 of the 0.8.0 plan, for review.

## Context

The default 512-integer engine answers `INCONCLUSIVE` on 303 of 460 independent runs (`docs/evaluation.md`), and says nothing about which models remain possible. Pooled probes already report `candidates`. Item 3 proposed two things:
- the same candidate list for single-request probes;
- fixed groups of models the probe cannot tell apart (equivalence classes), so that a probe could name a group.

An offline measurement on 2026-11-21 used the stored runs and the production scoring, with no provider requests. It kept the first part and ruled out the second.

**Candidate lists help.** The candidates are the models whose log likelihood is within the naming threshold of the most likely one and whose envelope accepts. On the 460 independent runs of enrolled models:
- the tested model is among them in 432 (94%);
- 171 lists hold one model, 16 are empty, and the lists average 3.6 models;
- 191 lists (42%) span more than one model family.

On the 225 runs of the four models removed in `0.7.0`, 222 lists are non-empty, they average 6.5 models, and 191 span more than one family. A candidate list therefore does not show that an endpoint runs an enrolled model.

**Fixed groups do not hold.** The models the review proposed to group do not form clean groups:
- runs of `gpt-6.1-sol` list `gpt-6-astra` in 100% of runs, but also `gpt-6.2-sol` in 100%, `gpt-6.2-astra` in 85%, `claude-fable-5.2` in 72%, and three Gemini models in 32–47%;
- the Gemini models and `claude-fable-5` show the same spread.

Near-permutation models from all three vendors look alike to this probe. So grouping models that "cannot be separated" chains them into one cross-vendor cluster. A fixed group `{gpt-6.1-sol, gpt-6-astra}` would not even resolve those runs, because `gpt-6.2-sol` stays within the threshold. Fixed groups are therefore dropped (see "Rejected").

## Decisions

| Topic | Decision |
| --- | --- |
| Candidate rule | When identification runs (at least two calibrated models) and at least one distance envelope accepts, `candidates` lists every calibrated model whose final log likelihood is within the sequential threshold `log((K − 1) / 0.005)` of the highest, and whose envelope at that sample count accepts. The order is most likely first; ties keep bank order. |
| By status | `IDENTIFIED` lists only the named model, which follows from the rule. `UNKNOWN_MODEL` lists none (`[]`). `INCONCLUSIVE` from separation lists the rule's set, which can be empty when the most likely models' envelopes all reject. |
| Omitted | `candidates` is absent, as today, when the engine does not score: a short response, no profile at that count, a bank with one calibrated model, or an uncalibrated bank. |
| Statuses | Unchanged. An empty list does not turn `INCONCLUSIVE` into `UNKNOWN_MODEL`. On independent runs that would wrongly reject 16 enrolled runs to gain 3 removed-model rejections. |
| Pooled probes | Unchanged: their `candidates` keep bank order. The field's documentation states both orders. |
| Engine plumbing | `SequentialDecision` gains `logLikelihoods: Record<string, number>`, each hypothesis's summed log likelihood. This is additive, and the candidate rule reads it. |
| CLI | No code change: the readable output already prints `Inconclusive, consistent with: <models>` when a result has more than one candidate. A test pins that it now does so for single-request banks. |
| Evaluation report | `schemaVersion` 2. Default-bank tallies gain `listed` (the tested model is a candidate), `empty`, `candidateCount` (summed list lengths) and `multiVendor` (the list spans more than one `family`). Pooled tallies gain `listed`. The markdown adds the matching columns. |
| Not changed | The naming rule, the envelopes, the banks, `confidence`, and the pooled engine. |

## Expected results on the current corpora

The status counts must stay exactly as committed: 152 / 0 / 303 / 5, 18 / 413 / 29, and 0 / 223 / 2. In addition:

| Default bank | Runs | Tested model listed | No candidate | Mean candidates | Several vendors |
| --- | --- | --- | --- | --- | --- |
| Enrolled models | 460 | 432 | 16 | 3.6 | 191 |
| Removed models | 225 | not applicable | 3 | 6.5 | 191 |

The label-removed row and the pooled `listed` counts are measured for the first time; the report records them.

## Documentation changes

Fixed copy.

**`README.md`: in the `INCONCLUSIVE` row of "Understand the result", replace "with `--pooled`, `candidates` lists the models still consistent" with:**

> `candidates` lists the enrolled models still consistent

**`docs/methodology.md`: insert after the paragraph that begins "With `K` fixed positive categorical hypotheses":**

> **Candidates.** When at least one distance envelope accepts, a result lists as `candidates` the enrolled models the sequential test cannot reject against the most likely one, with a log-likelihood ratio below the naming threshold, and whose envelope accepts; the most likely comes first. An identified result lists only the named model, and `UNKNOWN_MODEL` lists none. Candidates are always enrolled models. An unenrolled model also gets candidates, usually several and from more than one vendor, so a candidate list does not show that the endpoint runs an enrolled model.

**`docs/cli.md`: append to the paragraph that begins "`UNKNOWN_MODEL` means the observation falls outside all enrolled distance envelopes.":**

> Without `--pooled`, an `INCONCLUSIVE` result with several candidates prints `Inconclusive, consistent with: <models>`, most likely first, and JSON lists them in `candidates`; they are enrolled models only.

**`docs/bank.md`: insert after the bullet that begins "The distance envelopes rarely reject a run.":**

> - Each result also lists its `candidates`: the enrolled models the test cannot rule out. The tested model was among them in 432 of the 460 enrolled runs. The lists averaged 3.6 models, and 191 spanned more than one vendor, because near-permutation models from all three vendors look alike to this probe. Runs of the removed models got candidates in 222 of 225, averaging 6.5.

**`CHANGELOG.md`: under `## Unreleased` → `### Added`, add:**

> - Single-request probes report `candidates`, as pooled probes do: the enrolled models the sequential test cannot reject against the most likely one and whose distance envelope accepts, most likely first. The readable output prints `Inconclusive, consistent with: …`. `SequentialDecision` gains `logLikelihoods`. The evaluation report (schema version 2) adds how often the tested model is listed, mean list size and lists spanning several vendors.

## Rejected

**Fixed equivalence classes** (from the 2026-11-21 review).
- Grouping models the probe cannot separate chains near-permutation models of all three vendors into one group, so any fixed group is either too coarse to be useful or too fine to resolve a run.
- Per-probe candidate lists already say "consistent with these models" without fixing groups in the bank.
- Revisit only with a probe that separates these models.

## Out of scope

- Using the claimed model (a verification mode). Candidates are its building block: "consistent with the claim" means the claimed model is among them.
- Calibrated probabilities for candidates.
- Pooled ordering.
