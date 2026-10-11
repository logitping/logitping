# Pooled short-request probe (opt-in, experimental): design

Status: approved in conversation on 2026-10-11, pending written-spec review.

## Context

The bundled engine sends one 512-integer request. `openai/gpt-6.1-sol` and its teacher `gpt-6-astra` both answer with near-permutations: about 354 distinct values per 512 integers. Their value histograms are therefore almost flat. On fresh data (40 runs per model, collected 2026-10-11 through OpenRouter), the current engine returned `INCONCLUSIVE` for all 80 of their runs.

The offline evaluation compared several request formats and scoring methods. It used leave-group-out testing, and also the case where the model is unenrolled (left out of the bank):

| Requests per probe | Method | Enrolled, named wrongly | Unenrolled, named wrongly | Pair (sol/astra) correct |
|---|---|---|---|---|
| 1 × 512 | Current engine | 0/519 | 51/519 (10%) | 0/80 |
| 8 × 64 | Current engine, pooled | 0/65 | 24/65 (37%) | 3/10 |
| 8 × 64 | Prediction sets (C4) + per-response OOD gate | 1/65 | 9/65 (14%) | 6/10 |

Pooled short requests with prediction sets separate the pair far better, at about 0.72× the cost of one 512-integer request. They did not meet the predeclared open-set target (at most 10% of unenrolled models named wrongly). An unenrolled model is named as its closest enrolled relative from the same vendor, often from another generation. The gate test was designed after the fresh-data results were seen, so it is exploratory. At 8 requests the samples are small: 9/65 has a 95% interval of roughly 7–24%.

The method therefore ships as an **opt-in experimental mode**. The default probe and bundled bank are unchanged.

## Decisions

| Topic | Decision |
|---|---|
| Rollout | Opt-in experimental mode. The default stays 1 × 512 integers with the current bundled bank. |
| Request format | 8 requests × 64 integers per probe, fixed by the bank |
| Scoring | Mondrian (per-label) conformal prediction sets, `pooled-sets-v1`, equal to prototype variant C4, with each model's per-response 64-integer OOD envelope applied in front |
| Calibration | Cutoffs are fixed at enrollment by a seeded, cross-fitted bootstrap. The engine is deterministic and the bank stores no raw runs. |
| Single-model set | `HEURISTIC_MATCH`, exit 2, `confidence: null` |
| Opt-in | The bank declares the mode. `--pooled` / `pooledBank()` select the bundled pooled bank; `--bank` accepts a custom one. |
| Bank schema | `schemaVersion: 2` for pooled banks, so that 0.1.0 rejects them rather than probing them with one request |

## Bank format (schema version 2)

A pooled bank holds every v1 field, with these differences:

- `schemaVersion: 2`.
- `protocol.id` stays `integer-v1`, because the prompt is unchanged.
- `protocol.targetSamples: 64`: integers per request.
- `protocol.requestsPerProbe: 8`.
- `protocol.scoring: "pooled-sets-v1"`.
- `models[].integerProbabilities` and `models[].profiles` are fitted as v1 does: `profiles` at checkpoint 64 from the training runs, with thresholds from the validation runs.
- `pooled`:
  - `alpha: 0.2`. The miscoverage is split equally between the fit test and the margin test.
  - `bootstrap: { draws: 2000, seed: <uint32> }`.
  - `models[]`, in the same order as `models`:
    - `families`: seven smoothed probability vectors with sizes `[355, 355, 400, 100, 1420, 2840, 12]`.
    - `cutoffs: { fit: number, margin: number }`.
  - `pairs[]`: one entry per ordered pair of distinct model ids, `{ model, competitor, weights: number[7], center, scale }`.

### Validation

`validateBank` accepts v1 unchanged. For v2 it also checks:

- The `pooled` section is present.
- `protocol.requestsPerProbe` is an integer between 2 and 64.
- `scoring` is `"pooled-sets-v1"`.
- There are at least two models.
- Each family is a strictly positive distribution of the expected size.
- Pair weights are finite and non-negative, and `scale > 0`.
- Exactly one pair entry exists per ordered model pair.
- Cutoffs are finite.
- `pooled.models` matches `models` by count and order.

## Feature groups (`pooled-sets-v1`)

For a run `r` of `n` integers in `[1, 355]`, each group emits categorical events. The definitions are frozen exactly as tested:

| # | Group | Size | Events |
|---|---|---|---|
| 1 | value | 355 | `r[t] − 1` |
| 2 | step | 355 | `(r[t] − r[t−1] + 355) mod 355` for `t ≥ 1` |
| 3 | value-bin pair | 400 | `floor((r[t−1] − 1) / 17.75) · 20 + floor((r[t] − 1) / 17.75)` for `t ≥ 1` |
| 4 | last-digit pair | 100 | `(r[t−1] mod 10) · 10 + (r[t] mod 10)` for `t ≥ 1` |
| 5 | first use | 1420 | at each value's first occurrence `t`: `(r[t] − 1) · 4 + min(3, floor(t / 89))` |
| 6 | opening | 2840 | `t · 355 + r[t] − 1` for `t < 8` |
| 7 | repeat gap | 12 | per position: `0` for a value's first occurrence; otherwise `min(11, 1 + floor(log2(t − previous t)))` |

Model distributions use Jeffreys smoothing: `(count + 0.5) / (total + 0.5 · size)`, with counts pooled over all of the model's runs (training plus validation). The log-likelihood of a run under model `m` and group `f` is `Σ count_e · log p_{m,f}(e)`.

## Enrollment: `createPooledBank(input)`

The input is the same as `createFingerprintBank`'s. It additionally requires `requestsPerProbe` and accepts an optional `seed`, which defaults to `20261011`. The seed used is recorded in the bank.

1. **Envelopes.** Fit the v1 part exactly as `createFingerprintBank` does, at checkpoint 64.
2. **Cross-fitted log-likelihoods.** Every model's calibration set is all of its runs. For each calibration run `r` of model `a`, compute its log-likelihood under every model, per group. Under `a` itself, leave `r` out of `a`'s counts. Under any other model, use that model's full counts.
3. **Pair statistic for `(m, o)`, fitted on run sets `A` (of `m`) and `B` (of `o`).**
   - Per run, take the group-wise log-likelihood ratio vector, `llr_f = LL(r, m, f) − LL(r, o, f)`.
   - Weight per group: `w_f = (mean_A − mean_B) / pooledVar_f` when `pooledVar_f > 0` and `mean_A > mean_B`, otherwise `0`. Here `pooledVar_f` is the within-group sum of squares divided by `|A| + |B| − 2`. If every weight is 0, set all weights to 1.
   - `D(r) = Σ w_f · llr_f`, `center = (mean_A(D) + mean_B(D)) / 2`, and `scale = max(pooledSD(D), 1e-6)`. The `1e-6` floor matches the prototype's `sqrt(max(V, 1e-12))`.
   - Score: `(D(r) − center) / scale`.
   - The bank stores each pair statistic fitted on the full `A` and `B`.
4. **Calibration components for model `m` and its run `r`.**
   - `fit(r) = Σ_f LL(r, m, f)`, using the leave-`r`-out values from step 2.
   - `margin_o(r)`: the pair statistic `(m, o)` refitted with `r` removed from `A` (cross-fitting), applied to `r`.
5. **Bootstrap null for `k = requestsPerProbe`.** Use `mulberry32(seed)` and iterate over models in bank order. Draw `draws` tuples of `k` runs with replacement from the model's components. Aggregate each tuple:
   - `fitScore = Σ fit`;
   - `marginScore = min over o of (Σ margin_o) / sqrt(k)`.
6. **Cutoffs.** Let `c = floor((alpha/2) · (draws + 1))`, which is 200 for the defaults. A cutoff is the `c`-th smallest null value, so `cutoff = sorted[c − 1]`. A probe keeps the label iff `score ≥ cutoff`. This is exactly equivalent to the prototype's p-value test, `(1 + #{null ≤ s}) / (draws + 1) > alpha/2`.

Building twice from the same input and seed must produce byte-identical JSON.

## Engine

### Planning

`planProbe` reads `requestsPerProbe` from the bank, treating a v1 bank as 1.

- Protocol checks are unchanged. `samples` must equal `targetSamples` (64), and language, temperature and transport must match.
- `canStop` is `false` for pooled banks.
- Pooled identification needs at least two calibrated models, which validation enforces.

### Collection

The engine sends `requestsPerProbe` sequential requests with the same prompt and `maxTokens`.

- The overall deadline (`timeoutMs`, default 120 s) covers the optional tokenizer probe and every request.
- Each request runs under a child abort scope linked to the overall scope. Stopping a request once it has `targetSamples` integers aborts only that child. Today `collectIntegers` aborts the shared scope, so this behavior must change for multi-request probes.
- A reply with fewer than `targetSamples` integers ends the probe, and no further requests are sent. The result is `INCONCLUSIVE`, with a reason naming the request number and the received count.
- Malformed output raises `MALFORMED_OUTPUT`, as today.
- Nothing is retried.
- `onProgress` reports cumulative integers across requests. `onText` uses the stage `'integers'`.

### Classification

1. For each response `j` and model `m`:
   - compute group log-likelihoods under the bank distributions;
   - `fit_j(m) = Σ_f LL`;
   - `margin_j(m, o)` = the stored pair `(m, o)` score.
2. Aggregate:
   - `fitScore(m) = Σ_j fit_j(m)`;
   - `marginScore(m) = min_o Σ_j margin_j(m, o) / sqrt(k)`.
3. OOD gate: `accepted(m)` holds only if `assessOOD` accepts every response against `m`'s 64-integer profile, with the bank's nuisance projection.
4. Candidates: the models with `fitScore ≥ cutoffs.fit`, `marginScore ≥ cutoffs.margin` and `accepted`, in bank order.

### Result

| Candidates | `status` | `model` | `reason` |
|---|---|---|---|
| 1 | `HEURISTIC_MATCH` | the candidate | "Only X fits all 8 responses among enrolled models; an unenrolled model from the same vendor can produce the same result." |
| ≥ 2 | `INCONCLUSIVE` | `null` | "Consistent with X or Y; the responses do not separate them." |
| 0 | `UNKNOWN_MODEL` | `null` | "No enrolled model fits all 8 responses." |

New fields:

- `ProbeResult.candidates: string[]`, present only in pooled mode.
- `ProbeResult.requests: number`, present only in pooled mode.
- `samples` holds every integer in request order.
- `requestedSamples` and `evaluatedSamples` equal `targetSamples × requestsPerProbe`.
- `confidence` is `null`, and `earlyStopped` is `false`.
- `ModelScore` gains optional `fit`, `margin`, `fitCutoff` and `marginCutoff`.
  - `hellinger` and `mahalanobis` report the worst value across responses.
  - `accepted` is true only if every response passed.
  - `weight` is `null`.
- `warnings` adds two items:
  - the open-set caveat;
  - "This probe sent 8 requests."

`allowTransportMismatch` composes with the pooled mode: results are already `HEURISTIC_MATCH`, and the reason gains the cross-transport prefix.

## CLI and library

- **`--pooled`** selects the bundled pooled bank, as an explicit bank.
  - Combining `--pooled` with `--bank` is a usage error.
  - With `--driver claude|codex`, it fails with `PROTOCOL_MISMATCH` unless `--allow-transport-mismatch` is given.
- **`--bank <path>`** accepts a custom pooled bank, which is recognized from its protocol.
- **Interactive mode:** for API connections with a blank bank path, one select chooses between the standard bundled bank (1 × 512) and the experimental pooled bank (8 × 64).
- **Readable output:**
  - `HEURISTIC_MATCH` keeps today's "Heuristic match: X".
  - A set of two or more prints "Inconclusive, consistent with: X, Y".
  - JSON output includes `candidates` and `requests`.
- **`--max-tokens`** applies to each request. The docs recommend 4,096, which matches collection and is recorded in bank provenance.
- **Library exports:**
  - `pooledBank(): Promise<FingerprintBank>`, loaded through a dynamic import so the default path does not parse it;
  - `createPooledBank`;
  - updated types: a bank type covering v1 and v2, plus the `ProbeResult` and `ModelScore` additions.
- **`bank-create`** accepts `scoring` and `requestsPerProbe` in its input.

## Packaging

- The bundled pooled bank lives in `src/data/pooled_bank.json`, built from `research-64.local.json.corpus-4d34afe7….json`:
  - 13 models;
  - 25 training and 15 validation runs each;
  - 64 integers per run;
  - collected 2026-10-11 through OpenRouter, with a 4,096-token limit.
- Its provenance records the corpus SHA-256. The corpus stays git-ignored, as `*.corpus-*.json` already is.
- Under ESM the bank becomes a lazily loaded chunk; CommonJS inlines it.
- The unpacked package is expected to grow by about 5 MB, against about 13.5 MB of JS bundles today. The actual size is reported before handoff.
- `.gitignore` gains `src/data/pooled_bank.json.lock` and `src/data/pooled_bank.json.*.tmp`, alongside the existing default-bank entries.

## Bank maintenance

- **Checked-in config:** `config/pooled-bank-update.json`. It mirrors the research collection (the 13 current models, 25 + 15 runs, 64 integers, `maxTokens` 4,096, `maxProbeRetries` 5) and adds `"scoring": "pooled-sets-v1"` and `"requestsPerProbe": 8`.
- **Fitting:** the updater fits with `createPooledBank` when `scoring` is set. Collection, checkpoints, the loop check and provenance are unchanged.
- **Incremental updates:** unsupported for pooled banks, because the cutoffs depend on every model's runs and the bank stores none. An incremental run against a pooled config fails with a message asking for a full update.

## Documentation

- **README:** a short "Experimental: pooled short requests" section, with a `--pooled` example and the cost and caveats.
- **`docs/methodology.md`:** the feature groups, prediction sets, cross-fitting, cutoffs and the OOD gate.
- **`docs/bank.md`:** the pooled bank's contents and the exploratory evaluation table above, with its caveats: designed after seeing the data, small samples, and same-vendor naming of unenrolled models.
- **`docs/cli.md`:** `--pooled` and the readable output.
- **`docs/library.md`:** `pooledBank()` and `createPooledBank`.
- **`docs/bank-maintenance.md`:** the pooled config and the incremental-update restriction.
- **`CHANGELOG.md`:** entries under Unreleased.

## Testing

### Unit tests (CI)

- **Feature groups:** hand-built runs produce the expected events for every group, including the bin edges at 17.75 and the opening and first-use positions.
- **Enrollment:**
  - building twice gives byte-identical output;
  - cross-fitting leaves the run out, so its score on a small corpus differs from the in-sample score;
  - a single-model input is rejected;
  - cutoffs are finite.
- **Validation:** a valid v2 bank is accepted. Each v2 invariant listed above has a test that it is rejected when violated, and v1 behavior is unchanged.
- **Engine, with a fake multi-response transport:**
  - one candidate gives `HEURISTIC_MATCH`, two or more give `INCONCLUSIVE` with candidates, and none gives `UNKNOWN_MODEL`;
  - the OOD gate removes a model;
  - a short 5th reply gives `INCONCLUSIVE` naming request 5, after exactly 5 requests;
  - completing request 1 does not abort request 2;
  - the overall timeout and cancellation work across requests;
  - `samples: 512` against a pooled bank gives `PROTOCOL_MISMATCH`;
  - `earlyStopped` is false.
- **CLI:**
  - `--pooled` selects the bundled pooled bank, and combining it with `--bank` is an error;
  - exit code 2 for each pooled status;
  - the readable "consistent with" line, and JSON `candidates`;
  - the interactive choice.
- **Updater:**
  - a pooled config writes a v2 bank with provenance;
  - incremental mode with a pooled config fails before any request.
- **Bundled bank:** it validates, has 13 models and `requestsPerProbe: 8`, and its provenance includes the corpus SHA-256.
- **Package smoke (`npm run test:package`):** `pooledBank()` loads under both ESM and CommonJS installs.

### Equivalence with the evidence (local, needs the git-ignored corpus)

- Copy the session's research scripts into `scripts/research/`: the frozen `prototype.mjs` (SHA-256 `2964649026827d4774b2331b8a70c55b85a9eb3b2e4e7552166acdb40fffed24`), `prototype-eval.mjs` and `gate-test.mjs`.
- `scripts/research/check-pooled.mjs` reruns the leave-group-out evaluation at `k = 8` on the 64-integer corpus, using the production `createPooledBank` and engine scoring. It must show:
  - per-run group log-likelihoods and pair scores equal to the prototype's within `1e-9` on the same fits;
  - end-to-end results within ±2 units of the gate test: 45/65 correct singletons, 1/65 enrolled wrong, 9/65 unenrolled named wrongly. Exact equality is not expected, because the bootstrap draw order differs.

### Before handoff

- `npm run check`: typecheck, tests and build.
- `npm run test:package`.
- Optional, only with explicit approval: one live 8-request probe through OpenRouter, costing about $0.06.

## Out of scope

- The project website.
- Early stopping.
- Request counts other than the bank's.
- A loop check at probe time.
- Any change to the default bank or default probe.
- A better open-set gate. That is the unsolved problem, and work on it is separate.

## Risks

- **Unenrolled relatives.** An unenrolled model from the same vendor is named 14–21% of the time in exploratory testing, and the samples are small. Mitigations: the `HEURISTIC_MATCH` status, exit code 2, warnings and documentation.
- **Distribution shift.** The evidence comes from one collection day and one gateway, OpenRouter, without streaming. The CLI streams, and transfer between those modes has not been evaluated; this caveat is inherited from the current bank.
- **Cost.** A pooled probe sends 8 requests. It costs about 0.72× a 512-integer probe, but takes 8 round trips (about 25–60 s measured).
