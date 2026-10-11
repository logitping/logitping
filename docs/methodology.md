# Methodology

[Back to README](../README.md) · [Current bank and evaluation status](bank.md) · [Enrollment](bank-maintenance.md#create-a-measured-bank)

## What is measured

1. **Tokenizer boundary challenge (opt-in).** With `--tokenizer` (library: `tokenizerProbe: true`), a fixed English or Chinese prompt first asks for segmentation of whitespace, Unicode, CJK, identifiers, and a long word. The response is recorded as diagnostic text. An API completion cannot expose true internal BPE boundaries by prompting alone, so this response is excluded from identity classification. It is off by default because it costs an extra request and its wording makes a fingerprinting session easy for a proxy to recognize. Verifying `o200k`, `cl100k`, or proprietary Claude tokenization needs separately trusted tokenizer data or measurements.
2. **Integer preference probe.** The model generates a requested sequence of integers in `[1, 355]`. A strict incremental parser preserves numbers split across text chunks. It rejects prose, out-of-range values, decimals, signs, and scientific notation instead of cherry-picking valid-looking substrings.
3. **Sequential testing and OOD checks.** For calibrated banks, the engine updates fixed categorical log likelihoods after each complete integer. It evaluates the open-set gate at bank-specific sample counts. Early stopping requires agreement between the winning sequential hypothesis and that model's OOD gate, plus independent sequential validation recorded in the bank.

Features use Jeffreys smoothing (`alpha = 0.5`). The 1785-dimensional probability vector contains:

| Component | Dimensions | Total weight |
| --- | --- | --- |
| Whole-sequence frequencies | 355 | 1/3 |
| Four contiguous, approximately equal temporal blocks | 4 × 355 | 1/3 (1/12 each) |
| Integer ending digits (`value % 10`) | 10 | 1/3 |

Hellinger distance is `||sqrt(p) - sqrt(q)||₂ / sqrt(2)`. A reorthogonalized Gram–Schmidt basis projects nuisance directions out of the square-root feature differences. The implementation applies `(I − QQᵀ)v` without allocating a dense projection matrix. Nuisance directions must be learned from paired, labeled measurements of environment changes; none are invented by default. Projection affects the feature-space OOD gate; the sequential test still uses the enrolled categorical integer probabilities.

OOD rejection requires either projected Hellinger distance or a regularized **diagonal** Mahalanobis distance to exceed the model's calibrated threshold. A full covariance inverse is intentionally not fitted from a small number of runs. Each dimension's variance is shrunk toward the median positive variance of its feature block (whole sequence, each temporal block, endings) with the weight of four runs. Without that, a dimension on which every training run happened to agree would get a near-zero variance, and a single count difference there would dominate the distance. All models must provide profiles at the same checkpoints, including the target sample budget. A response that ends before the requested count is inconclusive, even at a calibrated checkpoint. Only the engine's own validated early stop classifies a prefix, so an endpoint can't choose its most favorable stopping point. Whole-sequence profiles are never applied to a short prefix.

With `K` fixed positive categorical hypotheses, the sequential threshold is `log((K − 1) / 0.005)`. After at least 64 integers, the winner must exceed every alternative by this log likelihood ratio. This is a conservative union-bound threshold under the fixed IID hypothesis model. Identification compares at least two calibrated models. A bank with one calibrated model reports that model's OOD verdict in `scores`: an accepted observation is `INCONCLUSIVE` because identification needs a competing reference, while a rejected observation is `UNKNOWN_MODEL`. Relative weights use log-sum-exp with equal priors. They are computed only after at least one OOD region accepts the observation and **are not calibrated identity probabilities**. Correlated integers, fitted probability estimates, and adaptive probes violate the simple test assumptions; empirical sequential evaluation is essential.

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
- every request returned 64 integers, and no reply repeated an earlier one. A short or repeated reply ends the probe as `INCONCLUSIVE` before scoring, because a caching or replaying endpoint, or deterministic sampling, does not give independent evidence.

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
