# Bundled reference bank

[Back to README](../README.md) · [Methodology](methodology.md) · [Bank maintenance](bank-maintenance.md)

## Collection snapshot

This describes the bank included in the experimental `0.6.0` npm release. It has 19 models: the eight `gpt-*` models, collected directly from OpenAI on 2026-11-06 (UTC); seven Claude models, the six of the `0.1.0` bank, byte for byte, and `claude-fable-5.2`, collected through OpenRouter on 2026-11-11 (UTC); and four Gemini models (family `gemini`), collected directly from Google AI Studio: `gemini-3.8-flash` and `gemini-4-argon` on 2026-10-21 (UTC), also unchanged, `gemini-4-carbon` on 2026-11-11 (UTC), and `gemini-4-hydrogen` on 2026-11-13 (UTC). The `0.5.0` release instead has 18 models, without `gemini-4-hydrogen`, and the `0.4.0` release has 16, also without `claude-fable-5.2` and `gemini-4-carbon`; their other entries are identical. The checked-in [bank](../src/data/default_bank.json) and its per-model provenance are the source of truth after any refresh. That source link requires a repository checkout; from an installed package, `defaultBank()` returns the bundled bank and its provenance.

| Setting | Value |
| --- | --- |
| Collection provider | OpenAI directly, with no relay (8 GPT models); OpenRouter (7 Claude models); Google AI Studio directly, with no relay (4 Gemini models) |
| Collection timestamp | `2026-11-06T22:22:10.199Z` (GPT models); `2026-10-03T10:19:52.961Z` (the six earlier Claude models); `2026-10-21T12:49:38.534Z` (`gemini-3.8-flash`); `2026-10-21T23:38:01.740Z` (`gemini-4-argon`); `2026-11-11T13:08:34.175Z` (`claude-fable-5.2`, `gemini-4-carbon`); `2026-11-13T22:24:18.555Z` (`gemini-4-hydrogen`); all UTC |
| References | 19 calibrated model entries |
| Accepted runs | 10 training + 5 threshold-calibration runs per model; 285 total |
| Protocol | `integer-v1`, English, first 512 integers in `[1, 355]` |
| Transport | `api`; collection requests used `stream: false` |
| Temperature | Omitted (`null` in the bank) |
| Output-token limit | 8,192 per request, including reasoning where applicable; 16,384 for `claude-fable-5.2`; 32,768 for `gemini-4-argon` and `gemini-4-carbon`; 65,536 for `gemini-4-hydrogen` |
| Distance checkpoints | 64, 128, 256, 512 integers |
| Nuisance directions | None |
| Early stopping | Disabled: `sequentialValidated: false` |

`calibrated` means that empirical distance envelopes were fitted. The five runs called `validation` in the data are used to set those envelopes; they are not an independent final evaluation set. Model labels record requested catalog routes, not independently attested backend identities. OpenRouter routing can select different upstream hosts, and the bank does not record the serving host of each run. The GPT requests went straight to OpenAI's API, and the Gemini requests to Google's OpenAI-compatible Chat Completions endpoint.

`gemini-4-argon` used up an 8,192-token budget, which reasoning shares, before finishing its answer, so it was collected with 32,768 tokens, its maximum output. Even then, 10 of its 25 replies that ended were cut off at the limit before 512 integers. Those requests were sent again, and provenance does not count them, because the updater stops at a cut-off reply instead of retrying it. Two more Argon requests timed out and were sent again. Argon's references therefore describe only replies that finish within 32,768 tokens; expect a similar share of Argon probes to end `INCONCLUSIVE` with a short reply.

`claude-fable-5.2` and `gemini-4-carbon` were collected together by one incremental update. Provenance records no retries and no short or invalid replies for either. Like Argon's, a reply cut off at the output limit would not appear there, because the updater stops at it instead of retrying.

`gemini-4-hydrogen` was collected alone by a later incremental update, with 65,536 output tokens per request, its documented maximum for one request: it always reasons before answering, and its reasoning counts against the limit. Provenance again records no retries and no short or invalid replies, and again would not show a reply cut off at the limit.

## Model list

Each entry used the 8,192-token output limit above, except `claude-fable-5.2`, which used 16,384; `gemini-4-argon` and `gemini-4-carbon`, which used 32,768; and `gemini-4-hydrogen`, which used 65,536. These are the routes and formats recorded at collection time, not a promise of ongoing catalog availability or access for every account. Routes with a vendor prefix were requested through OpenRouter; the GPT models were requested from OpenAI, and the four Gemini models from Google AI Studio.

| Bank model ID | Requested route | API format | Token-limit field |
| --- | --- | --- | --- |
| `gpt-6.1-sol` | `gpt-6.1-sol` | `responses` | `max_output_tokens` |
| `gpt-6.1-terra` | `gpt-6.1-terra` | `responses` | `max_output_tokens` |
| `gpt-6-sol` | `gpt-6-sol` | `responses` | `max_output_tokens` |
| `gpt-6-luna` | `gpt-6-luna` | `responses` | `max_output_tokens` |
| `gpt-6-astra` | `gpt-6-astra` | `chat-completions` | `max_completion_tokens` |
| `gpt-5.6-luna` | `gpt-5.6-luna` | `responses` | `max_output_tokens` |
| `gpt-5.6-terra` | `gpt-5.6-terra` | `responses` | `max_output_tokens` |
| `gpt-5.6-sol` | `gpt-5.6-sol` | `responses` | `max_output_tokens` |
| `claude-sonnet-5.5` | `anthropic/claude-sonnet-5.5` | `messages` | `max_tokens` |
| `claude-opus-5.5` | `anthropic/claude-opus-5.5` | `messages` | `max_tokens` |
| `claude-fable-5.1` | `anthropic/claude-fable-5.1` | `messages` | `max_tokens` |
| `claude-fable-5.2` | `anthropic/claude-fable-5.2` | `messages` | `max_tokens` |
| `claude-opus-5` | `anthropic/claude-opus-5` | `messages` | `max_tokens` |
| `claude-sonnet-5` | `anthropic/claude-sonnet-5` | `messages` | `max_tokens` |
| `claude-fable-5` | `anthropic/claude-fable-5` | `messages` | `max_tokens` |
| `gemini-3.8-flash` | `gemini-3.8-flash` | `chat-completions` | `max_tokens` |
| `gemini-4-argon` | `gemini-4-argon` | `chat-completions` | `max_tokens` |
| `gemini-4-carbon` | `gemini-4-carbon` | `chat-completions` | `max_tokens` |
| `gemini-4-hydrogen` | `gemini-4-hydrogen` | `chat-completions` | `max_tokens` |

The probe CLI defaults to 2,624 output tokens for 512 integers. Use `--max-tokens 8192` to match this bank's collection limit, `--max-tokens 16384` for `claude-fable-5.2`, `--max-tokens 32768` for `gemini-4-argon` and `gemini-4-carbon`, or `--max-tokens 65536` for `gemini-4-hydrogen`; a smaller budget can truncate reasoning models before all integers arrive. Matching the budget and format does not establish transfer across hosts or streaming modes.

## Evaluation status

There is no published independent estimate of real-model identification accuracy, unknown-model error rates, or latency savings. Keep early stopping disabled until independent sequential evaluation supports enabling it.

Replaying the 95 stored threshold-calibration runs through the current 19-model bank, at 512 samples with early stopping disabled and no provider requests, gave:

| Tested models | Bank | Label matches | Wrong matches | `INCONCLUSIVE` | `UNKNOWN_MODEL` |
| --- | --- | --- | --- | --- | --- |
| GPT (40 runs) | Full bundled bank | 14 | 0 | 26 | 0 |
| GPT (40 runs) | Without the tested label | Not applicable | 0 | 40 | 0 |
| Claude (35 runs) | Full bundled bank | 15 | 0 | 20 | 0 |
| Claude (35 runs) | Without the tested label | Not applicable | 3 | 27 | 5 |
| Gemini (20 runs) | Full bundled bank | 0 | 0 | 20 | 0 |
| Gemini (20 runs) | Without the tested label | Not applicable | 0 | 20 | 0 |

The three wrong matches were `claude-fable-5.1` named as `claude-fable-5` once and `claude-fable-5` as `claude-fable-5.1` twice, each with nominal `confidence` above 99.99%. On the full bank, all five runs of `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-astra`, `gpt-5.6-sol`, the three Fable models, and the four Gemini models were `INCONCLUSIVE`. The full-bank rows reuse samples that fitted the tested model's thresholds, so none of this estimates independent accuracy.

The same replay of the 90 earlier runs through the 18-model `0.5.0` bank reproduces its published results. Adding `gemini-4-hydrogen` changed two of them, both now `INCONCLUSIVE`. A `claude-opus-5.5` run that the full bank named correctly keeps the same log-likelihood lead over `claude-fable-5.2`, 8.158, but the lead needed to name a model, `log((K − 1) / 0.005)` for K references, rises from 8.132 with 18 to 8.189 with 19. With Carbon removed, the `gemini-4-carbon` run that was named as `gemini-4-argon` now splits its weight between Argon (50.1%) and Hydrogen (49.9%). Every other result is unchanged.

The `0.5.0` bank had in turn changed two results of the 16-model `0.4.0` bank, both wrong matches with the tested label removed, which became `INCONCLUSIVE`: a `gpt-6-astra` run named as `gpt-6.1-sol`, and a `gemini-3.8-flash` run named as `gemini-4-argon`.

On the full bank, `claude-fable-5.2`'s own reference gets most of the weight on its runs: 98.9–99.8% on four and 73% on the fifth. No run's lead reaches the naming threshold, though, and each falls inside 18 or 19 of the 19 distance envelopes. With `claude-fable-5.2` removed, each run still falls inside 17 or 18 of the remaining 18, so none is rejected as `UNKNOWN_MODEL`. The highest weight then goes to `gemini-4-hydrogen` on three runs (35–60%) and to `gpt-6.1-sol` and `claude-opus-5.5` on one each; the largest is Opus's 78%.

`gemini-4-carbon`'s own reference gets 51–94% of the weight on its runs. With Carbon removed, Argon gets the highest weight on four runs (50–76%) and Hydrogen on the fifth (57%), and none is named; on the `0.5.0` bank, Argon got 82–100% on every run and named one. As with Flash and Argon, the Gemini models are hard to tell apart at 512 integers: with all four enrolled, no Gemini run is named, correctly or wrongly.

`gemini-4-hydrogen`'s own reference gets 88–95% of the weight on four of its runs; on the fifth, `gemini-3.8-flash` gets 73% and Hydrogen 25%. No lead reaches the naming threshold, and each run falls inside 14 to 19 of the 19 distance envelopes. With Hydrogen removed, each run still falls inside 13 to 18 of the remaining 18, so none is rejected as `UNKNOWN_MODEL`, and the highest weight always goes to another Gemini model: Flash on one run (97%), Argon on two (57% and 83%), and Carbon on two (41% and 73%).

Hydrogen also draws weight from another vendor's model when that model is removed: with `claude-sonnet-5.5` removed, it gets the highest weight on three of that model's runs, 35%, 74% and 91%, where the `0.5.0` bank gave it to `gemini-4-argon` twice and `claude-fable-5.2` once. None of those runs is named.

The results below describe earlier banks, whose GPT references were collected through OpenRouter.

The 2026-10-03 release review replayed the 65 stored threshold-calibration runs through `fingerprint()` at 512 samples with early stopping disabled. It made no provider requests:

| Diagnostic | Label matches | Wrong matches | `INCONCLUSIVE` | `UNKNOWN_MODEL` |
| --- | --- | --- | --- | --- |
| Full bundled bank | 24 | 0 | 41 | 0 |
| Remove the tested label before each replay | Not applicable | 4 | 56 | 5 |

The full-bank replay reuses samples that fitted the tested model's distance thresholds and must not be reported as independent accuracy. For the second diagnostic, each model was removed in turn and its five runs compared with the remaining 12 references. Because models were fitted separately and nuisance directions are empty, those five runs did not fit the remaining models' profiles. Nevertheless, this is a small, selected set of nearby models from one collection, not an estimate for arbitrary unknown endpoints. Both `INCONCLUSIVE` and `UNKNOWN_MODEL` withhold an identity claim.

The four wrong matches in the second diagnostic were:

| Removed label | Returned model | Number of runs |
| --- | --- | --- |
| `gpt-6-luna` | `gpt-6-sol` | 1 |
| `claude-fable-5.1` | `claude-fable-5` | 1 |
| `claude-fable-5` | `claude-fable-5.1` | 2 |

All four had nominal `confidence` above 99.99%. This demonstrates why a relative likelihood must not be presented as a validated identity probability. The catalog labels themselves also remain assumptions about the requested routes.

After the two Gemini models were added, the same replay of all 75 stored runs through the 15-model bank reproduced every one of the 65 results above. The ten Gemini runs gave:

| Tested model | Bank | Label matches | Wrong matches | `INCONCLUSIVE` | `UNKNOWN_MODEL` |
| --- | --- | --- | --- | --- | --- |
| `gemini-3.8-flash` | Full bundled bank | 0 | 0 | 5 | 0 |
| `gemini-3.8-flash` | Without `gemini-3.8-flash` | Not applicable | 0 | 5 | 0 |
| `gemini-4-argon` | Full bundled bank | 0 | 0 | 5 | 0 |
| `gemini-4-argon` | Without `gemini-4-argon` | Not applicable | 0 | 5 | 0 |

The two Gemini models' outputs are hard to tell apart at 512 integers. Before Argon was enrolled, the 14-model bank matched two of Flash's runs; adding Argon turned both into `INCONCLUSIVE`. Without Argon in the bank, three of Argon's five runs gave `gemini-3.8-flash` 90–98% of the weight, short of a match.

With both Gemini models removed, each Gemini run still fell inside 4 to 13 of the 13 remaining distance envelopes, so none was rejected as `UNKNOWN_MODEL`. The highest weights went to `gpt-6-astra` and `gpt-6.1-sol`, split too evenly to name either. An unenrolled model from another vendor can therefore fall inside the envelopes of enrolled ones. The same caveats apply: these runs also fitted the Gemini models' thresholds, and five runs per model are not an accuracy estimate.

Before making stronger claims, evaluate new, independent runs across known and unenrolled models, collection dates, serving hosts, streaming modes, and supported transports. Report confusion matrices, the rate of inconclusive results, incorrect matches, OOD rejection, and short or malformed output, including rejected collection attempts. Evaluate every stopping checkpoint separately if early stopping is proposed.

## Data availability and reproducibility

The eight GPT models and the six earlier Claude models each reference their own corpus, `gemini-3.8-flash`, `gemini-4-argon`, and `gemini-4-hydrogen` each reference a separate one, and `claude-fable-5.2` and `gemini-4-carbon` share one, with digests:

```text
74df5aa4c36a4ea42eba4ab3822d5dba8e988d4b24533832736591d9df070381  GPT models
163709a6a44653bd0d9e12ab6114687305487845428dfcb163e57f0ab17fe225  Six earlier Claude models; also holds the superseded GPT runs
ccf4eb2395577f019a6fc45cc8295ba647e7babd269ed52ed6c51945069c2d06  gemini-3.8-flash
a1dcbf342056bf36db7dfa24d1b3b3a2844d51b486cf001c1c098b90e600e0e3  gemini-4-argon
cb4da985e4067620f7e984eed4e3e0fa783776f6f96bc4b190ea0d8b1773685f  claude-fable-5.2 and gemini-4-carbon
71d2cd1615a8dd4473696752e8eb0b8ba35e0df226154b2cd6a9028e1c22f7fc  gemini-4-hydrogen
```

Each digest is SHA-256 over UTF-8 `JSON.stringify({ protocol, checkpoints, models })` in that property order, using the corpus fields. It is not the digest of the entire file: the file also includes `schemaVersion`, `collectedAt`, and a trailing newline.

During the release review, the matching local corpus reproduced the digest and every fitted `integerProbabilities` and `profiles` field through `createFingerprintBank()`. Each Gemini corpus does the same for its entry, the GPT corpus for its eight entries, and the 2026-11-11 corpus for its two. The corpus is currently a Git-ignored maintainer file; it is not distributed in this repository or npm tarballs, and no public download is available yet. External users therefore cannot currently reproduce these diagnostics from the repository alone. Publishing reviewed data, its usage terms, and an evaluation recipe remains release follow-up work.

Maintainers with the matching corpus can reproduce the diagnostic from the repository root after building. Replace `CORPUS_PATH` with the local corpus path, and run it once per corpus; this command only reads local data and performs no provider requests:

```sh
CORPUS_PATH=./src/data/default_bank.json.corpus-163709a6a44653bd0d9e12ab6114687305487845428dfcb163e57f0ab17fe225.json node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { defaultBank, fingerprint } from './dist/index.js';

const corpus = JSON.parse(readFileSync(process.env.CORPUS_PATH, 'utf8'));
const bank = defaultBank();
const totals = { full: {}, excluded: {} };
for (const model of corpus.models) {
  // A corpus can hold superseded runs of a model that was collected again later.
  const digest = /corpus sha256:([0-9a-f]{64})/.exec(bank.models.find(ref => ref.id === model.id).provenance)[1];
  if (!process.env.CORPUS_PATH.includes(digest)) continue;
  for (const samples of model.validation) {
    for (const mode of ['full', 'excluded']) {
      const references = mode === 'full' ? bank : {
        ...bank, models: bank.models.filter(ref => ref.id !== model.id),
      };
      const transport = {
        name: 'openai', granularity: 'token',
        async *stream() { yield samples.join(' ') + ' '; },
      };
      const result = await fingerprint(transport, { bank: references, earlyStopping: false });
      const outcome = result.status === 'IDENTIFIED'
        ? (result.model === model.id ? 'labelMatch' : 'wrongMatch') : result.status;
      totals[mode][outcome] = (totals[mode][outcome] ?? 0) + 1;
    }
  }
}
console.log(JSON.stringify(totals, null, 2));
NODE
```

## Experimental pooled bank

`--pooled` (library: `pooledBank()`) uses a second bundled bank, `src/data/pooled_bank.json`. It covers 19 models from four collections:

- the eight `gpt-*` models, collected directly from OpenAI on 2026-11-06;
- the six earlier Claude models, whose runs were collected through OpenRouter on 2026-10-11 and reused;
- `claude-fable-5.2`, through OpenRouter, and the first three Gemini models, directly from Google AI Studio, collected on 2026-11-11 (UTC);
- `gemini-4-hydrogen`, directly from Google AI Studio, collected on 2026-11-13 (UTC).

Every collection ran without streaming: 25 training and 15 held-out runs of 64 English integers per model, with 4,096 output tokens per request, except 32,768 for `gemini-4-argon` and `gemini-4-carbon` and 65,536 for `gemini-4-hydrogen`. Pooled cutoffs and pair statistics were fitted on the runs of all 19 models; the earlier models' envelopes are unchanged. Provenance records each model's corpus SHA-256: `5472cb6f40f49804d4b314cef8f2d4c95f3aaeb0923c22eb75ece68f5b47435b` for GPT, `4d34afe7497e9d0d83238136885022a808a5c0e6ecfcfc32b7ed5689131f0bbf` for the six earlier Claude models, `be70762f6c14be2256680199954c580c68a426dcb7b3c83b4607bdd89a6eca84` for `claude-fable-5.2` and the first three Gemini models, and `6a284c99d6ac48b86c8f87be0c3afe4a8c60265345de70693a5f4d406a448a3a` for `gemini-4-hydrogen`. The `0.5.0` release has the first 18 models only, and the `0.4.0` release the first 14. Each probe sends 8 requests; see [methodology](methodology.md#experimental-pooled-probe-pooled-sets-v1).

Exploratory leave-group-out results follow. Each group of 8 runs was probed against a bank fitted without those runs. "Unenrolled" means the model was removed from the bank and its runs probed against the rest. The "earlier bank" had 13 models, all collected through OpenRouter on 2026-10-11; the "`0.4.0` bank" and "`0.5.0` bank" are the 14- and 18-model banks of those releases. The 1 × 512 row comes from a 512-integer collection made the same day; it has not been repeated, because there is no comparable 40-run direct collection.

| Probe | Enrolled model named wrongly | Unenrolled model named | `gpt-6.1-sol` / `gpt-6-astra` named correctly |
| --- | --- | --- | --- |
| 1 × 512 integers, default engine, 2026-10-11 | 0/519 | 51/519 (10%) | 0/80 |
| 8 × 64 integers, earlier pooled bank | 1/65 | 9/65 (14%) | 6/10 |
| 8 × 64 integers, `0.4.0` pooled bank (14 models) | 2/70 (3%) | 11/70 (16%) | 2/10 |
| 8 × 64 integers, `0.5.0` pooled bank (18 models) | 2/90 (2%) | 16/90 (18%) | 2/10 |
| 8 × 64 integers, current pooled bank (19 models) | 2/95 (2%) | 16/95 (17%) | 2/10 |

Adding `gemini-4-hydrogen` left every first-grouping result of the 18 earlier models unchanged, including both wrong answers and all 16 unenrolled names. Hydrogen was named correctly in 4 of its 5 probes, and the fifth returned no candidate; removed from the bank, none of its five probes named a model. The right model was named in 61 of 95 probes, against 57 of 90 on the `0.5.0` bank.

In the `0.5.0` bank, adding `claude-fable-5.2` and the three Gemini models had likewise left every first-grouping result of the 14 earlier models unchanged. Its five extra unenrolled names were all `gemini-4-carbon`: removed from the bank, each of its five probes named `gemini-4-argon`. With every model enrolled, those four models were never named wrongly or left among several candidates: `claude-fable-5.2` was named correctly in 5 of its 5 probes and each Gemini model in 3, and the rest returned no candidate.

Treat these as exploratory:

- The pooled test was designed after the first collection's results were seen.
- The samples are small. On the current bank, the 95% intervals are about 1–7% for 2/95, 11–26% for 16/95, and 6–51% for 2/10.
- The current bank, like the `0.4.0` and `0.5.0` banks, misses all three predeclared targets: enrolled models named wrongly under 1%, unenrolled models named at most 10%, and the pair named correctly at least 50% of the time. The earlier bank met only the pair target, and [missed it on new runs](#held-out-runs-of-gpt-61-sol-and-gpt-6-astra).
- Unenrolled models were named as similar models from the same vendor. In the pooled tests, none was named as a model from another vendor.

The mode is therefore opt-in, and a single-model result is a `HEURISTIC_MATCH`.

To locate the errors, the pooled test was repeated with 10 different groupings of each model's 40 runs into 5 probes of 8, giving 50 probes per model. The first grouping is the one in the table above. Across all groupings, the earlier bank named the right model in 487/650 probes (75%), the `0.4.0` bank in 464/700 (66%), the `0.5.0` bank in 613/900 (68%), and the current bank in 652/950 (69%). The first three rows below have every model enrolled; the rest test a model removed from the bank.

| Tested model | Bank | Named instead | Earlier bank | `0.4.0` bank | `0.5.0` bank | Current bank |
| --- | --- | --- | --- | --- | --- | --- |
| `gpt-6-astra` | All models | `gpt-6.1-sol` | 10/50 | 14/50 | 14/50 | 14/50 |
| `gpt-6.1-sol` | All models | `gpt-6-astra` | 1/50 | 16/50 | 16/50 | 16/50 |
| Each other model | All models | Any other model | 0/550 | 0/600 | 0/800 | 0/850 |
| `gpt-6-astra` | Without the tested model | `gpt-6.1-sol` | 50/50 | 45/50 | 45/50 | 45/50 |
| `gpt-6.1-sol` | Without the tested model | `gpt-6-astra` | 6/50 | 34/50 | 34/50 | 34/50 |
| `gpt-6-luna` | Without the tested model | `gpt-6-sol` | 25/50 | 2/50 | 2/50 | 2/50 |
| `gpt-5.6-luna` | Without the tested model | `gpt-6-sol` | 2/50 | 21/50 | 21/50 | 21/50 |
| `gpt-5.6-terra` | Without the tested model | Another GPT model | 2/50 | 10/50 | 10/50 | 10/50 |
| `gemini-4-carbon` | Without the tested model | `gemini-4-argon` | Not enrolled | Not enrolled | 50/50 | 48/50 |
| `gemini-4-hydrogen` | Without the tested model | `gemini-4-argon` | Not enrolled | Not enrolled | Not enrolled | 5/50 |
| Each other model | Without the tested model | A same-vendor model | 4/400 | 2/450 | 2/600 | 2/600 |

**An unenrolled `gemini-4-carbon` is named as `gemini-4-argon`** in 48 of 50 probes, and in all 50 on the `0.5.0` bank, so a pooled result naming Argon does not rule out Carbon when Carbon is not enrolled. An unenrolled `gemini-4-hydrogen` is also named as Argon, in 5 of 50 probes, and the rest return no candidate. The reverse did not occur: with Argon removed, none of its 50 probes named Carbon, Hydrogen, or any other model. Removing `claude-fable-5.2` or `gemini-3.8-flash` also left every one of their probes without a candidate. With every model enrolled, Hydrogen was named correctly in 39 of 50 probes and never wrongly or among several candidates; the rest returned no candidate. Apart from Carbon's two probes, adding Hydrogen changed no count of the 18 earlier models across all groupings. In the `0.5.0` bank, adding four models had changed one count of the 14 earlier ones: `claude-sonnet-5.5` was named correctly in 39/50 probes instead of 40/50, with one more probe returning no candidate.

**Neither pooled bank separates `gpt-6.1-sol` and `gpt-6-astra` on runs from other collections.** Across the groupings, the current bank named them correctly in 8/100 probes and the earlier bank in 55/100. But the earlier bank's 55/100 was measured on the same collection it was built from; on runs from later collections it got 38/100 and 16/100 (see below). A result naming either one does not rule out the other. Every wrong answer with all models enrolled was between these two. Why the two collections gave such different leave-group-out results is unknown.

These counts replace figures published here earlier: 48/50, 26/50 and 9/50, and 0/50 for `gpt-6.1-sol` named as `gpt-6-astra`. Those came from a script that was not kept and used different random groupings. The earlier claim that the confusion ran only one way depended on those groupings: here, the earlier bank named `gpt-6.1-sol` as `gpt-6-astra` once in 50 probes.

The groupings reuse the runs each bank was built from, so these counts show where errors concentrate, not how often they occur on new data.

Probes can also come from a different collection than the bank. This tests references across provider and about four weeks, for the seven GPT models in both banks: 50 probes per model, with no run scored against a bank it helped fit. The groupings still reuse each model's same 40 runs.

| Probes from | Bank | Other five GPT models: correct, wrong | `gpt-6.1-sol` / `gpt-6-astra`: correct, wrong |
| --- | --- | --- | --- |
| OpenRouter, 2026-10-11 | Current | 208/250, 0 | 14/100, 17 |
| OpenAI, 2026-11-06 | Earlier | 210/250, 0 | 38/100, 12 |

The first row was measured on the `0.4.0` bank; the `0.5.0` bank and the current bank give the same counts. So references for the five other models carried across provider and date with no wrong answers in 500 probes. This has been measured only for the pooled bank; default-bank probes through OpenRouter against the direct GPT references have not been evaluated.

### Held-out runs of `gpt-6.1-sol` and `gpt-6-astra`

On 2026-11-07, 40 new runs of each of these two models were collected directly from OpenAI under the current bank's settings. Neither bank was built from them. The test and the rule for reading it were committed before the runs were collected; see [the plan](../scripts/research/README.md#held-out-test-of-gpt-61-sol-and-gpt-6-astra). Each bank was probed with 10 groupings of the 80 runs, 100 probes in all.

| Result | Current bank | Earlier bank |
| --- | --- | --- |
| Correct single model | 15/100 | 16/100 |
| Wrong single model | 25/100 | 40/100 |
| Several candidates | 48/100 | 27/100 |
| No candidate | 12/100 | 17/100 |
| Correct, first grouping only | 2/10 | 1/10 |

The current bank in this table is the `0.4.0` bank; the 18-model `0.5.0` bank and the current 19-model bank give the same counts on these runs. Neither bank met the plan's bar of at least 50 correct and at most 20 wrong, so the current bank was kept. With runs from another collection, this pair was named correctly in 14–38 of 100 probes in every test.

- The test favors the current bank: the new runs use the same route as its references and came a day later.
- Counts vary between collections: the earlier bank got 38/100 on the 2026-11-06 runs and 16/100 on these.
- Probes sent through OpenRouter were not tested.

Three offline changes to the pooled test were tried on the earlier collection: a novelty test on the pooled score, a fit test for each feature group, and a minimum lead over the second-best model. Those that lowered the unenrolled rate below 10%, to 7.5–9.5%, also cut correct single-model results for enrolled models from 73% to 34–62%. None was adopted.

[`scripts/research/pooled-eval.mjs`](../scripts/research/README.md#pooled-evaluation) computes the pooled counts above from the stored runs, which are not in this repository.
