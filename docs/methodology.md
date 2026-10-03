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
