# Bundled reference bank

[Back to README](../README.md) · [Methodology](methodology.md) · [Bank maintenance](bank-maintenance.md)

## Collection snapshot

This describes the bank included in the experimental `0.7.0` npm release. It has 18 models: seven `gpt-*` models, collected directly from OpenAI, five on 2026-11-06 (UTC) and `gpt-6.2-astra` and `gpt-6.2-sol` on 2026-11-18 (UTC); seven Claude models, the six of the `0.1.0` bank, byte for byte, and `claude-fable-5.2`, collected through OpenRouter on 2026-11-11 (UTC); and four Gemini models (family `gemini`), collected directly from Google AI Studio: `gemini-4-argon` on 2026-10-21 (UTC), also unchanged, `gemini-4-carbon` on 2026-11-11 (UTC), `gemini-4-hydrogen` on 2026-11-13 (UTC), and `gemini-4-neon` on 2026-11-19 (UTC). The three GPT-5.6 models and `gemini-3.8-flash` were removed. The `0.6.0` release instead has 19 models: it also enrolls those four, but not the two GPT-6.2 models or `gemini-4-neon`. The `0.5.0` release has 18, also without `gemini-4-hydrogen`, and the `0.4.0` release has 16, also without `claude-fable-5.2` and `gemini-4-carbon`. The entries they share are identical. The checked-in [bank](../src/data/default_bank.json) and its per-model provenance are the source of truth after any refresh. That source link requires a repository checkout; from an installed package, `defaultBank()` returns the bundled bank and its provenance.

| Setting | Value |
| --- | --- |
| Collection provider | OpenAI directly, with no relay (7 GPT models); OpenRouter (7 Claude models); Google AI Studio directly, with no relay (4 Gemini models) |
| Collection timestamp | `2026-11-06T22:22:10.199Z` (the five earlier GPT models); `2026-10-03T10:19:52.961Z` (the six earlier Claude models); `2026-10-21T23:38:01.740Z` (`gemini-4-argon`); `2026-11-11T13:08:34.175Z` (`claude-fable-5.2`, `gemini-4-carbon`); `2026-11-13T22:24:18.555Z` (`gemini-4-hydrogen`); `2026-11-18T23:33:59.984Z` (`gpt-6.2-astra`, `gpt-6.2-sol`); `2026-11-19T22:49:17.038Z` (`gemini-4-neon`); all UTC |
| References | 18 calibrated model entries |
| Accepted runs | 10 training + 5 threshold-calibration runs per model; 270 total |
| Protocol | `integer-v1`, English, first 512 integers in `[1, 355]` |
| Transport | `api`; collection requests used `stream: false` |
| Temperature | Omitted (`null` in the bank) |
| Output-token limit | 8,192 per request, including reasoning where applicable; 16,384 for `claude-fable-5.2`; 32,768 for `gpt-6.2-astra`, `gpt-6.2-sol`, `gemini-4-argon` and `gemini-4-carbon`; 65,536 for `gemini-4-hydrogen` and `gemini-4-neon` |
| Distance checkpoints | 64, 128, 256, 512 integers |
| Nuisance directions | None |
| Early stopping | Disabled: `sequentialValidated: false` |

`calibrated` means that empirical distance envelopes were fitted. The five runs called `validation` in the data are used to set those envelopes; they are not an independent final evaluation set. Model labels record requested catalog routes, not independently attested backend identities. OpenRouter routing can select different upstream hosts, and the bank does not record the serving host of each run. The GPT requests went straight to OpenAI's API, and the Gemini requests to Google's OpenAI-compatible Chat Completions endpoint.

`gemini-4-argon` used up an 8,192-token budget, which reasoning shares, before finishing its answer, so it was collected with 32,768 tokens, its maximum output. Even then, 10 of its 25 replies that ended were cut off at the limit before 512 integers. Those requests were sent again, and provenance does not count them, because the updater stops at a cut-off reply instead of retrying it. Two more Argon requests timed out and were sent again. Argon's references therefore describe only replies that finish within 32,768 tokens; expect a similar share of Argon probes to end `INCONCLUSIVE` with a short reply.

`claude-fable-5.2` and `gemini-4-carbon` were collected together by one incremental update. Provenance records no retries and no short or invalid replies for either. Like Argon's, a reply cut off at the output limit would not appear there, because the updater stops at it instead of retrying.

`gemini-4-hydrogen` was collected alone by a later incremental update, with 65,536 output tokens per request, its documented maximum for one request: it always reasons before answering, and its reasoning counts against the limit. Provenance again records no retries and no short or invalid replies, and again would not show a reply cut off at the limit.

`gpt-6.2-astra` and `gpt-6.2-sol` were collected together by a later incremental update, with 32,768 output tokens per request. A first attempt with 8,192 stopped when a `gpt-6.2-sol` reply was cut off before 512 integers; its runs were discarded and both models were collected again with the larger budget. Provenance records six retries for `gpt-6.2-astra`, all after short replies, four in training and two in validation, and five for `gpt-6.2-sol`, after four invalid replies, two in each set, and one short validation reply. As for the others, a reply cut off at the limit would not appear there.

`gemini-4-neon` was collected alone by a later incremental update, with 65,536 output tokens per request, its documented maximum for one request: like Hydrogen, it always reasons before answering, and its reasoning counts against the limit. Provenance records no retries and no short or invalid replies, and would not show a reply cut off at the limit.

## Model list

Each entry used the 8,192-token output limit above, except `claude-fable-5.2`, which used 16,384; `gpt-6.2-astra`, `gpt-6.2-sol`, `gemini-4-argon` and `gemini-4-carbon`, which used 32,768; and `gemini-4-hydrogen` and `gemini-4-neon`, which used 65,536. These are the routes and formats recorded at collection time, not a promise of ongoing catalog availability or access for every account. Routes with a vendor prefix were requested through OpenRouter; the GPT models were requested from OpenAI, and the four Gemini models from Google AI Studio.

| Bank model ID | Requested route | API format | Token-limit field |
| --- | --- | --- | --- |
| `gpt-6.2-astra` | `gpt-6.2-astra` | `responses` | `max_output_tokens` |
| `gpt-6.2-sol` | `gpt-6.2-sol` | `responses` | `max_output_tokens` |
| `gpt-6.1-sol` | `gpt-6.1-sol` | `responses` | `max_output_tokens` |
| `gpt-6.1-terra` | `gpt-6.1-terra` | `responses` | `max_output_tokens` |
| `gpt-6-sol` | `gpt-6-sol` | `responses` | `max_output_tokens` |
| `gpt-6-luna` | `gpt-6-luna` | `responses` | `max_output_tokens` |
| `gpt-6-astra` | `gpt-6-astra` | `chat-completions` | `max_completion_tokens` |
| `claude-sonnet-5.5` | `anthropic/claude-sonnet-5.5` | `messages` | `max_tokens` |
| `claude-opus-5.5` | `anthropic/claude-opus-5.5` | `messages` | `max_tokens` |
| `claude-fable-5.1` | `anthropic/claude-fable-5.1` | `messages` | `max_tokens` |
| `claude-fable-5.2` | `anthropic/claude-fable-5.2` | `messages` | `max_tokens` |
| `claude-opus-5` | `anthropic/claude-opus-5` | `messages` | `max_tokens` |
| `claude-sonnet-5` | `anthropic/claude-sonnet-5` | `messages` | `max_tokens` |
| `claude-fable-5` | `anthropic/claude-fable-5` | `messages` | `max_tokens` |
| `gemini-4-argon` | `gemini-4-argon` | `chat-completions` | `max_tokens` |
| `gemini-4-carbon` | `gemini-4-carbon` | `chat-completions` | `max_tokens` |
| `gemini-4-hydrogen` | `gemini-4-hydrogen` | `chat-completions` | `max_tokens` |
| `gemini-4-neon` | `gemini-4-neon` | `chat-completions` | `max_tokens` |

Each model entry records its collection settings in `collection`: the provider, requested route, API format, token-limit field, output budget, collection time and corpus digest. When `--model` names an enrolled model, as `openai/gpt-6.1-sol` names `gpt-6.1-sol`, the CLI applies its recorded `--max-tokens`, and its `--token-limit-field` when the probe uses the recorded API format, unless you pass them yourself. A smaller budget can truncate reasoning models before all integers arrive. The CLI does not switch `--provider` or `--api-format`, because endpoints differ in what they support and how they authenticate; it notes the flags that would match the recorded format. Matching the budget and format does not establish transfer across hosts or streaming modes.

## Evaluation status

The [evaluation report](evaluation.md), generated by `npm run bank:evaluate`, scores the bundled banks on every stored run they were not built from, without provider requests. For the default bank, these are 460 runs of 10 enrolled models, collected through OpenRouter on 2026-10-03 and 2026-10-11, and 225 runs of the four models removed in `0.7.0`:

| Default bank, 512 integers | Runs | Named correctly | Named wrongly | `INCONCLUSIVE` | `UNKNOWN_MODEL` |
| --- | --- | --- | --- | --- | --- |
| Enrolled models | 460 | 152 | 0 | 303 | 5 |
| Same runs, tested model removed | 460 | Not applicable | 18 | 413 | 29 |
| Models removed in `0.7.0` | 225 | Not applicable | 0 | 223 | 2 |

- The GPT runs test references across provider and date, because the references came directly from OpenAI on 2026-11-06. `gpt-6-luna` was named correctly in all 55 of its runs, `gpt-6-sol` in 4 of 55, and `gpt-6.1-sol` and `gpt-6-astra` in none of 110.
- The 18 wrong names with the tested model removed were all between `claude-fable-5` and `claude-fable-5.1`.
- The distance envelopes rarely reject a run. All 29 rejections with the tested model removed were `claude-sonnet-5` runs, and only 2 of 225 runs of the removed models were rejected. An unenrolled model therefore usually returns `INCONCLUSIVE`, like an enrolled model the bank cannot separate from its neighbors.
- Each result also lists its `candidates`: the enrolled models the test cannot rule out. The tested model was among them in 432 of the 460 enrolled runs. The lists averaged 3.6 models, and 191 spanned more than one vendor, because near-permutation models from all three vendors look alike to this probe. Runs of the removed models got candidates in 222 of 225, averaging 6.5.

This is still not an estimate for arbitrary endpoints: the runs share providers with the references, cover 10 of the 18 models, and were not streamed. There is no estimate of latency savings. Keep early stopping disabled until independent sequential evaluation supports enabling it.

The replays below reuse each model's own threshold-calibration runs. They show where errors concentrate, not how often they occur.

Replaying the 90 stored threshold-calibration runs through the current 18-model bank, at 512 samples with early stopping disabled and no provider requests, gave:

| Tested models | Bank | Label matches | Wrong matches | `INCONCLUSIVE` | `UNKNOWN_MODEL` |
| --- | --- | --- | --- | --- | --- |
| GPT (35 runs) | Full bundled bank | 6 | 0 | 29 | 0 |
| GPT (35 runs) | Without the tested label | Not applicable | 0 | 35 | 0 |
| Claude (35 runs) | Full bundled bank | 16 | 0 | 19 | 0 |
| Claude (35 runs) | Without the tested label | Not applicable | 3 | 27 | 5 |
| Gemini (20 runs) | Full bundled bank | 0 | 0 | 20 | 0 |
| Gemini (20 runs) | Without the tested label | Not applicable | 0 | 20 | 0 |

The three wrong matches were `claude-fable-5.1` named as `claude-fable-5` once and `claude-fable-5` as `claude-fable-5.1` twice, each with nominal `confidence` above 99.99%. On the full bank, all five runs of `gpt-6.2-astra`, `gpt-6.2-sol`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-astra`, the three Fable models, and the four Gemini models were `INCONCLUSIVE`. The full-bank rows reuse samples that fitted the tested model's thresholds, so none of this estimates independent accuracy.

Of these 90 runs, the 75 of the 15 models that the 19-model `0.6.0` bank also enrolls give its published results except one: the `claude-opus-5.5` run that it left `INCONCLUSIVE` is named correctly again. Its lead over `claude-fable-5.2`, 8.158, is unchanged, and the lead needed to name a model, `log((K − 1) / 0.005)` for K references, falls from 8.189 with 19 to 8.132 with 18. The 85 runs of the 17 models that the unreleased 21-model bank of commit `1f1b6e7` also enrolls differ from its published results in that run only. The removed models' 20 stored runs are no longer replayed. On the intermediate 22-model bank, which enrolled `gemini-4-neon` before the four models were removed, another `claude-opus-5.5` run was also `INCONCLUSIVE`: its lead over `gpt-6.2-astra`, 8.333, fell just short of the 8.343 needed with 22 references.

The 21-model bank had in turn changed one result of the 19-model `0.6.0` bank: a `gpt-5.6-terra` run became `INCONCLUSIVE`, keeping its lead over `gpt-6.1-terra`, 8.288, while the lead needed rose from 8.189 with 19 references to 8.294 with 21.

The `0.6.0` bank had in turn changed two results of the 18-model `0.5.0` bank, both to `INCONCLUSIVE`. A `claude-opus-5.5` run kept its lead over `claude-fable-5.2`, 8.158, while the lead needed rose from 8.132 with 18 references to 8.189 with 19. With Carbon removed, the `gemini-4-carbon` run that was named as `gemini-4-argon` split its weight between Argon (50.1%) and Hydrogen (49.9%).

The `0.5.0` bank had in turn changed two results of the 16-model `0.4.0` bank, both wrong matches with the tested label removed, which became `INCONCLUSIVE`: a `gpt-6-astra` run named as `gpt-6.1-sol`, and a `gemini-3.8-flash` run named as `gemini-4-argon`.

On the full bank, `claude-fable-5.2`'s own reference gets most of the weight on its runs: 98.8–99.6% on four and 76% on the fifth. No run's lead reaches the naming threshold, though, and each falls inside 17 or 18 of the 18 distance envelopes. With `claude-fable-5.2` removed, each run still falls inside 16 or 17 of the remaining 17, so none is rejected as `UNKNOWN_MODEL`. The highest weight then goes to `gpt-6.2-sol` on two runs (49% and 64%), to `gemini-4-hydrogen` on two (43% and 46%), and to `gpt-6.1-sol` on one (31%). On the `0.6.0` bank, Hydrogen got it on three runs, and `gpt-6.1-sol` and `claude-opus-5.5` (78%) on one each.

`gemini-4-carbon`'s own reference gets 49–94% of the weight on its runs. With Carbon removed, Argon gets the highest weight on three runs (47–80%), Hydrogen on one (54%) and Neon on one (82%), and none is named; on the `0.5.0` bank, Argon got 82–100% on every run and named one. The Gemini models are hard to tell apart at 512 integers: with all four enrolled, no Gemini run is named, correctly or wrongly.

`gemini-4-hydrogen`'s own reference gets the highest weight on all five of its runs: 75–89% on four, and 50% on the fifth, where Neon gets 44%. No lead reaches the naming threshold, and each run falls inside 14 to 18 of the 18 distance envelopes. With Hydrogen removed, each run still falls inside 13 to 17 of the remaining 17, so none is rejected as `UNKNOWN_MODEL`, and the highest weight always goes to another Gemini model: Neon on three runs (60–88%), and Argon (76%) and Carbon (59%) on one each. On the 21-model bank, Hydrogen's own reference got 88–95% on four runs, and with Hydrogen removed the highest weight went to Flash once, Argon twice and Carbon twice.

Hydrogen also draws weight from another vendor's model when that model is removed: with `claude-sonnet-5.5` removed, it gets the highest weight on three of that model's runs, 49%, 73% and 92%, where the `0.5.0` bank gave it to `gemini-4-argon` twice and `claude-fable-5.2` once. None of those runs is named.

`gpt-6.2-astra`'s own reference gets 92.9–99.8% of the weight on four of its runs and 62% on the fifth. `gpt-6.2-sol`'s own reference gets the highest weight on four of its runs, 54–89%; on the fifth, `gpt-6.1-sol` gets 47% and Sol 24%. No lead reaches the naming threshold, and each run falls inside 9 to 18 of the 18 distance envelopes. With the tested model removed, each run still falls inside 8 to 17 of the remaining 17, so none is rejected as `UNKNOWN_MODEL`, and none is named. Without Astra, `gpt-6.2-sol` gets the highest weight on four of Astra's runs (37–68%) and `gpt-6.1-sol` on the fifth (69%). Without Sol, it goes to `gpt-6.1-sol` on two of Sol's runs (52% and 61%), to `gpt-6-astra` on two (37% and 72%), and to `claude-fable-5.2` on one (53%).

The two GPT-6.2 models also draw weight from other models' runs when those models are removed: `gpt-6.2-astra` gets the highest weight on two runs of `claude-opus-5.5` (49% and 92%), and `gpt-6.2-sol` on two of `claude-fable-5.2` and one of `gpt-6.1-terra` (49–64%). None of those runs is named.

`gemini-4-neon`'s own reference gets the highest weight on two of its runs, 61% and 93%. On the other three, `gemini-4-hydrogen` gets the highest weight, 46–85%, and Neon 5–27%. No lead reaches the naming threshold, and each run falls inside 16 to 18 of the 18 distance envelopes. With Neon removed, each run still falls inside 15 to 17 of the remaining 17, so none is rejected as `UNKNOWN_MODEL`, and Hydrogen gets the highest weight on every run (54–98%) without naming any.

Neon also draws weight from the other Gemini models' runs when those models are removed: it gets the highest weight on three runs of `gemini-4-hydrogen` (60–88%) and one of `gemini-4-carbon` (82%). None of those runs is named.

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

The five earlier GPT models and the six earlier Claude models each reference their own corpus, `gemini-4-argon`, `gemini-4-hydrogen`, and `gemini-4-neon` each reference a separate one, `claude-fable-5.2` and `gemini-4-carbon` share one, and so do `gpt-6.2-astra` and `gpt-6.2-sol`, with digests:

```text
74df5aa4c36a4ea42eba4ab3822d5dba8e988d4b24533832736591d9df070381  Five earlier GPT models; also holds the removed GPT-5.6 models' runs
163709a6a44653bd0d9e12ab6114687305487845428dfcb163e57f0ab17fe225  Six earlier Claude models; also holds the superseded GPT runs
a1dcbf342056bf36db7dfa24d1b3b3a2844d51b486cf001c1c098b90e600e0e3  gemini-4-argon
cb4da985e4067620f7e984eed4e3e0fa783776f6f96bc4b190ea0d8b1773685f  claude-fable-5.2 and gemini-4-carbon
71d2cd1615a8dd4473696752e8eb0b8ba35e0df226154b2cd6a9028e1c22f7fc  gemini-4-hydrogen
0a49c2ace8e2ac9e94bef896019d85c4b55fd013f5db3e4da755962ebeae5b3f  gpt-6.2-astra and gpt-6.2-sol
dff2abd244a6b7ed281930ca8e4da8c17897e0732ae85d15978e8d7d20ed3a94  gemini-4-neon
```

Each digest is SHA-256 over UTF-8 `JSON.stringify({ protocol, checkpoints, models })` in that property order, using the corpus fields. It is not the digest of the entire file: the file also includes `schemaVersion`, `collectedAt`, and a trailing newline.

During the release review, the matching local corpus reproduced the digest and every fitted `integerProbabilities` and `profiles` field through `createFingerprintBank()`. Each Gemini corpus does the same for its entry, the 2026-11-06 GPT corpus for its five entries, and the 2026-11-11 and 2026-11-18 corpora for their two each. The corpus is currently a Git-ignored maintainer file; it is not distributed in this repository or npm tarballs, and no public download is available yet. External users therefore cannot currently reproduce these diagnostics from the repository alone. Publishing reviewed data, its usage terms, and an evaluation recipe remains release follow-up work.

Maintainers with the matching corpus can reproduce the diagnostic from the repository root after building. Replace `CORPUS_PATH` with the local corpus path, and run it once per corpus; this command only reads local data and performs no provider requests:

```sh
CORPUS_PATH=./src/data/default_bank.json.corpus-163709a6a44653bd0d9e12ab6114687305487845428dfcb163e57f0ab17fe225.json node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { defaultBank, fingerprint } from './dist/index.js';

const corpus = JSON.parse(readFileSync(process.env.CORPUS_PATH, 'utf8'));
const bank = defaultBank();
const totals = { full: {}, excluded: {} };
for (const model of corpus.models) {
  // A corpus can hold runs of a removed model, or superseded runs of one collected again later.
  const reference = bank.models.find(ref => ref.id === model.id);
  if (!reference) continue;
  const digest = /corpus sha256:([0-9a-f]{64})/.exec(reference.provenance)[1];
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

`--pooled` (library: `pooledBank()`) uses a second bundled bank, `src/data/pooled_bank.json`. It covers 18 models from six collections:

- five `gpt-*` models, collected directly from OpenAI on 2026-11-06;
- the six earlier Claude models, whose runs were collected through OpenRouter on 2026-10-11 and reused;
- `claude-fable-5.2`, through OpenRouter, and `gemini-4-argon` and `gemini-4-carbon`, directly from Google AI Studio, collected on 2026-11-11 (UTC);
- `gemini-4-hydrogen`, directly from Google AI Studio, collected on 2026-11-13 (UTC);
- `gpt-6.2-astra` and `gpt-6.2-sol`, directly from OpenAI, collected on 2026-11-19 (UTC);
- `gemini-4-neon`, directly from Google AI Studio, collected on 2026-11-19 (UTC).

Every collection ran without streaming: 25 training and 15 held-out runs of 64 English integers per model, with 4,096 output tokens per request, except 32,768 for `gpt-6.2-astra`, `gpt-6.2-sol`, `gemini-4-argon` and `gemini-4-carbon`, and 65,536 for `gemini-4-hydrogen` and `gemini-4-neon`. Pooled cutoffs and pair statistics were fitted on the runs of all 18 models; the earlier models' envelopes are unchanged. The 2026-11-06 and 2026-11-11 collections also hold the runs of the removed GPT-5.6 models and `gemini-3.8-flash`, which the fit leaves out. Provenance records each model's corpus SHA-256: `5472cb6f40f49804d4b314cef8f2d4c95f3aaeb0923c22eb75ece68f5b47435b` for the five earlier GPT models, `4d34afe7497e9d0d83238136885022a808a5c0e6ecfcfc32b7ed5689131f0bbf` for the six earlier Claude models, `be70762f6c14be2256680199954c580c68a426dcb7b3c83b4607bdd89a6eca84` for `claude-fable-5.2`, `gemini-4-argon` and `gemini-4-carbon`, `6a284c99d6ac48b86c8f87be0c3afe4a8c60265345de70693a5f4d406a448a3a` for `gemini-4-hydrogen`, `bd4f73c0e86eeddd4d5eb4377bf2b67054b25d6dde1e86718a9b745f6161f91b` for `gpt-6.2-astra` and `gpt-6.2-sol`, and `40eb0a8bb730da70fb2d43adbbbd320de9d11842abd024d6ebf695ed27478e99` for `gemini-4-neon`. The `0.6.0` release has 19 models: the first 15 here and the four removed ones. The `0.5.0` release has the same without `gemini-4-hydrogen`, and the `0.4.0` release only the eight GPT and six Claude models. Each probe sends 8 requests; see [methodology](methodology.md#experimental-pooled-probe-pooled-sets-v1).

Exploratory leave-group-out results follow. Each group of 8 runs was probed against a bank fitted without those runs. "Unenrolled" means the model was removed from the bank and its runs probed against the rest. The "earlier bank" had 13 models, all collected through OpenRouter on 2026-10-11; the "`0.4.0` bank", "`0.5.0` bank" and "`0.6.0` bank" are the 14-, 18- and 19-model banks of those releases, the "21-model bank" is the unreleased bank of commit `1f1b6e7`, and the "22-model bank" added `gemini-4-neon` to it before the three GPT-5.6 models and `gemini-3.8-flash` were removed. The 1 × 512 row comes from a 512-integer collection made the same day; it has not been repeated, because there is no comparable 40-run direct collection.

| Probe | Enrolled model named wrongly | Unenrolled model named | `gpt-6.1-sol` / `gpt-6-astra` named correctly |
| --- | --- | --- | --- |
| 1 × 512 integers, default engine, 2026-10-11 | 0/519 | 51/519 (10%) | 0/80 |
| 8 × 64 integers, earlier pooled bank | 1/65 | 9/65 (14%) | 6/10 |
| 8 × 64 integers, `0.4.0` pooled bank (14 models) | 2/70 (3%) | 11/70 (16%) | 2/10 |
| 8 × 64 integers, `0.5.0` pooled bank (18 models) | 2/90 (2%) | 16/90 (18%) | 2/10 |
| 8 × 64 integers, `0.6.0` pooled bank (19 models) | 2/95 (2%) | 16/95 (17%) | 2/10 |
| 8 × 64 integers, 21-model pooled bank | 3/105 (3%) | 20/105 (19%) | 2/10 |
| 8 × 64 integers, 22-model pooled bank | 3/110 (3%) | 20/110 (18%) | 2/10 |
| 8 × 64 integers, current pooled bank (18 models) | 3/90 (3%) | 17/90 (19%) | 2/10 |

Removing the three GPT-5.6 models and `gemini-3.8-flash` left every first-grouping result of the other 18 models with every model enrolled unchanged, including all three wrong answers. Three of the 20 unenrolled names had come from the removed models' own probes, all named as `gpt-6-sol`. With the tested model removed, one `gemini-4-carbon` probe that was named as `gemini-4-argon` now returns no candidate, and a `gpt-6.2-astra` probe that returned several candidates is now named as `gpt-6.1-sol`. The right model was named in 59 of 90 probes, against 73 of 110 on the 22-model bank and 61 of 95 on the `0.6.0` bank.

In the 22-model bank, adding `gemini-4-neon` had left every first-grouping result of the 21 earlier models unchanged, including all three wrong answers and all 20 unenrolled names. Neon was named correctly in 4 of its 5 probes, and the fifth returned no candidate; removed from the bank, none of its five probes named a model, and the same holds on the current bank. The right model was named in 73 of 110 probes, against 69 of 105 on the 21-model bank.

In the 21-model bank, adding `gpt-6.2-astra` and `gpt-6.2-sol` had left every first-grouping result of the 19 earlier models unchanged, including both wrong answers and all 16 unenrolled names. Each new model was named correctly in 4 of its 5 probes. The fifth `gpt-6.2-sol` probe returned no candidate, and the fifth `gpt-6.2-astra` probe was named as `gpt-6.1-sol`, the third wrong answer. Removed from the bank, four of Astra's five probes were named as another GPT model, `gpt-6.2-sol` twice and `gpt-6.1-sol` and `gpt-6-astra` once each, and the fifth returned several candidates; none of Sol's five probes named a model. The right model was named in 69 of 105 probes, against 61 of 95 on the `0.6.0` bank.

In the `0.6.0` bank, adding `gemini-4-hydrogen` had left every first-grouping result of the 18 earlier models unchanged, including both wrong answers and all 16 unenrolled names. Hydrogen was named correctly in 4 of its 5 probes, and the fifth returned no candidate; removed from the bank, none of its five probes named a model. The right model was named in 61 of 95 probes, against 57 of 90 on the `0.5.0` bank.

In the `0.5.0` bank, adding `claude-fable-5.2` and the three Gemini models had likewise left every first-grouping result of the 14 earlier models unchanged. Its five extra unenrolled names were all `gemini-4-carbon`: removed from the bank, each of its five probes named `gemini-4-argon`. With every model enrolled, those four models were never named wrongly or left among several candidates: `claude-fable-5.2` was named correctly in 5 of its 5 probes and each Gemini model in 3, and the rest returned no candidate.

Treat these as exploratory:

- The pooled test was designed after the first collection's results were seen.
- The samples are small. On the current bank, the 95% intervals are about 1–9% for 3/90, 12–28% for 17/90, and 6–51% for 2/10.
- The current bank, like the `0.4.0`, `0.5.0` and `0.6.0` banks and the 21- and 22-model banks, misses all three predeclared targets: enrolled models named wrongly under 1%, unenrolled models named at most 10%, and the pair named correctly at least 50% of the time. The earlier bank met only the pair target, and [missed it on new runs](#held-out-runs-of-gpt-61-sol-and-gpt-6-astra).
- Unenrolled models were named as similar models from the same vendor. In the pooled tests, none was named as a model from another vendor.

The mode is therefore opt-in, and a single-model result is a `HEURISTIC_MATCH`.

To locate the errors, the pooled test was repeated with 10 different groupings of each model's 40 runs into 5 probes of 8, giving 50 probes per model. The first grouping is the one in the table above. Across all groupings, the earlier bank named the right model in 487/650 probes (75%), the `0.4.0` bank in 464/700 (66%), the `0.5.0` bank in 613/900 (68%), the `0.6.0` bank in 652/950 (69%), the 21-model bank in 729/1050 (69%), the 22-model bank in 768/1100 (70%), and the current bank in 614/900 (68%). The first four rows below have every model enrolled; the rest test a model removed from the bank.

| Tested model | Bank | Named instead | Earlier bank | `0.4.0` bank | `0.5.0` bank | `0.6.0` bank | Current bank |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `gpt-6-astra` | All models | `gpt-6.1-sol` | 10/50 | 14/50 | 14/50 | 14/50 | 14/50 |
| `gpt-6.1-sol` | All models | `gpt-6-astra` | 1/50 | 16/50 | 16/50 | 16/50 | 16/50 |
| `gpt-6.2-astra` | All models | `gpt-6.1-sol` | Not enrolled | Not enrolled | Not enrolled | Not enrolled | 1/50 |
| Each other model | All models | Any other model | 0/550 | 0/600 | 0/800 | 0/850 | 0/750 |
| `gpt-6-astra` | Without the tested model | `gpt-6.1-sol` | 50/50 | 45/50 | 45/50 | 45/50 | 45/50 |
| `gpt-6.1-sol` | Without the tested model | `gpt-6-astra` | 6/50 | 34/50 | 34/50 | 34/50 | 33/50 |
| `gpt-6-luna` | Without the tested model | `gpt-6-sol` | 25/50 | 2/50 | 2/50 | 2/50 | 6/50 |
| `gpt-5.6-luna` | Without the tested model | `gpt-6-sol` | 2/50 | 21/50 | 21/50 | 21/50 | Removed |
| `gpt-5.6-terra` | Without the tested model | Another GPT model | 2/50 | 10/50 | 10/50 | 10/50 | Removed |
| `gemini-4-carbon` | Without the tested model | `gemini-4-argon` | Not enrolled | Not enrolled | 50/50 | 48/50 | 43/50 |
| `gemini-4-hydrogen` | Without the tested model | `gemini-4-argon` | Not enrolled | Not enrolled | Not enrolled | 5/50 | 3/50 |
| `gpt-6.2-astra` | Without the tested model | Another GPT model | Not enrolled | Not enrolled | Not enrolled | Not enrolled | 26/50 |
| Each other model | Without the tested model | A same-vendor model | 4/400 | 2/450 | 2/600 | 2/600 | 1/600 |

**An unenrolled `gemini-4-carbon` is named as `gemini-4-argon`** in 43 of 50 probes, against 48 on every bank from `0.6.0` to the 22-model bank and all 50 on the `0.5.0` bank, so a pooled result naming Argon does not rule out Carbon when Carbon is not enrolled. An unenrolled `gemini-4-hydrogen` is also named as Argon, in 3 of 50 probes, and the rest return no candidate; before Neon was enrolled, in 5 of 50. The reverse did not occur: with Argon removed, none of its 50 probes named Carbon, Hydrogen, Neon, or any other model. Removing `claude-fable-5.2` also leaves every one of its probes without a candidate. With every model enrolled, Hydrogen was named correctly in 40 of 50 probes and never wrongly or among several candidates; the rest returned no candidate. In the `0.6.0` bank, apart from Carbon's two probes, adding Hydrogen had changed no count of the 18 earlier models across all groupings. In the `0.5.0` bank, adding four models had changed one count of the 14 earlier ones: `claude-sonnet-5.5` was named correctly in 39/50 probes instead of 40/50, with one more probe returning no candidate.

**An unenrolled `gpt-6.2-astra` is named as another GPT model** in 26 of 50 probes: as `gpt-6.2-sol` in 14, `gpt-6.1-sol` in 10, and `gpt-6-astra` in 2. An unenrolled `gpt-6.2-sol` was never named as another model. With every model enrolled, `gpt-6.2-astra` was named correctly in 42 of 50 probes, as `gpt-6.1-sol` in one, and among several candidates in one, and `gpt-6.2-sol` in 37 of 50 and never wrongly; the rest returned no candidate. In the 21-model bank, adding the two models had changed three counts of the 19 earlier models across all groupings, each by one probe: `gpt-6.1-terra` was named correctly in 40/50 instead of 41/50, with one more probe returning no candidate; removed from the bank, `gpt-6.1-sol` was named as `gpt-6-astra` in 33/50 instead of 34/50, and `gpt-5.6-sol` as `gpt-6.1-terra` in 2/50 instead of 1/50.

**An unenrolled `gemini-4-neon` was never named as another model**: removed from the bank, all 50 of its probes returned no candidate. With every model enrolled, Neon was named correctly in 39 of 50 probes and never wrongly or among several candidates; the rest returned no candidate. In the 22-model bank, adding Neon had changed one count of the 21 earlier models across all groupings: removed from the bank, `gemini-4-hydrogen` was named as `gemini-4-argon` in 3/50 probes instead of 5/50, and those two probes returned no candidate.

**Removing the three GPT-5.6 models and `gemini-3.8-flash`** changed eight counts of the other 18 models across all groupings. With every model enrolled, `gpt-6-sol` was named correctly in 38/50 probes instead of 40/50 and `gemini-4-argon` in 37/50 instead of 39/50, the other probes returning no candidate, while `gemini-4-hydrogen` was named correctly in 40/50 instead of 39/50 and `gpt-6.2-astra` in 42/50 instead of 41/50. Removed from the bank, `gpt-6-luna` is now named as `gpt-6-sol` in 6/50 probes instead of 2/50, `gemini-4-carbon` as `gemini-4-argon` in 43/50 instead of 48/50, `gpt-6.2-astra` as `gpt-6.1-sol` in 10/50 instead of 9/50, and `gpt-6-sol`, never named before, as `gpt-6.1-terra` in 1/50.

**Neither pooled bank separates `gpt-6.1-sol` and `gpt-6-astra` on runs from other collections.** Across the groupings, the current bank named them correctly in 8/100 probes and the earlier bank in 55/100. But the earlier bank's 55/100 was measured on the same collection it was built from; on runs from later collections it got 38/100 and 16/100 (see below). A result naming either one does not rule out the other. Every wrong answer with all models enrolled was between these two, except one `gpt-6.2-astra` probe named as `gpt-6.1-sol`. Why the two collections gave such different leave-group-out results is unknown.

These counts replace figures published here earlier: 48/50, 26/50 and 9/50, and 0/50 for `gpt-6.1-sol` named as `gpt-6-astra`. Those came from a script that was not kept and used different random groupings. The earlier claim that the confusion ran only one way depended on those groupings: here, the earlier bank named `gpt-6.1-sol` as `gpt-6-astra` once in 50 probes.

The groupings reuse the runs each bank was built from, so these counts show where errors concentrate, not how often they occur on new data.

Probes can also come from a different collection than the bank. This tests references across provider and about four weeks, for the seven GPT models that the earlier bank and the `0.4.0` bank both enroll: 50 probes per model, with no run scored against a bank it helped fit. The groupings still reuse each model's same 40 runs.

| Probes from | Bank | Other five GPT models: correct, wrong | `gpt-6.1-sol` / `gpt-6-astra`: correct, wrong |
| --- | --- | --- | --- |
| OpenRouter, 2026-10-11 | `0.4.0` | 208/250, 0 | 14/100, 17 |
| OpenAI, 2026-11-06 | Earlier | 210/250, 0 | 38/100, 12 |

The `0.5.0` and `0.6.0` banks and the 21- and 22-model banks give the same counts as the `0.4.0` bank in the first row. The current bank no longer enrolls three of the other five, the GPT-5.6 models. On the other two, `gpt-6-sol` and `gpt-6-luna`, it named the right model in 87 of 100 probes and never the wrong one, against 90 on the earlier banks, because three more `gpt-6-sol` probes returned no candidate; its `gpt-6.1-sol` / `gpt-6-astra` counts are unchanged. So references for the five other models carried across provider and date with no wrong answers in 500 probes. For the default bank, the same kind of test is in [Evaluation status](#evaluation-status).

The four models removed in `0.7.0` give an open-set test of the current pooled bank, which was refitted without them; the pooled banks of earlier releases enrolled them from these same runs. There are 350 probes from their stored runs, 50 per model and collection. The current bank named a model in 51 of them, always a GPT model, `gpt-6-sol` in 41 and `gpt-6.1-terra` in 10, and returned no candidate in the other 299. The rate depends on the collection: `gpt-5.6-terra` was named in 3 of 50 probes of the 2026-10-11 OpenRouter runs and in 21 of 50 of the 2026-11-06 OpenAI runs. `gemini-3.8-flash` was never named. See the [evaluation report](evaluation.md).

### Held-out runs of `gpt-6.1-sol` and `gpt-6-astra`

On 2026-11-07, 40 new runs of each of these two models were collected directly from OpenAI under the current bank's settings. Neither bank was built from them. The test and the rule for reading it were committed before the runs were collected; see [the plan](../scripts/research/README.md#held-out-test-of-gpt-61-sol-and-gpt-6-astra). Each bank was probed with 10 groupings of the 80 runs, 100 probes in all.

| Result | Current bank | Earlier bank |
| --- | --- | --- |
| Correct single model | 15/100 | 16/100 |
| Wrong single model | 25/100 | 40/100 |
| Several candidates | 48/100 | 27/100 |
| No candidate | 12/100 | 17/100 |
| Correct, first grouping only | 2/10 | 1/10 |

The current bank in this table is the `0.4.0` bank; the 18-model `0.5.0` bank, the 19-model `0.6.0` bank, the 21- and 22-model banks and the current 18-model bank give the same counts on these runs. Neither bank met the plan's bar of at least 50 correct and at most 20 wrong, so the current bank was kept. With runs from another collection, this pair was named correctly in 14–38 of 100 probes in every test.

- The test favors the current bank: the new runs use the same route as its references and came a day later.
- Counts vary between collections: the earlier bank got 38/100 on the 2026-11-06 runs and 16/100 on these.
- Probes sent through OpenRouter were not tested.

Three offline changes to the pooled test were tried on the earlier collection: a novelty test on the pooled score, a fit test for each feature group, and a minimum lead over the second-best model. Those that lowered the unenrolled rate below 10%, to 7.5–9.5%, also cut correct single-model results for enrolled models from 73% to 34–62%. None was adopted.

[`scripts/research/pooled-eval.mjs`](../scripts/research/README.md#pooled-evaluation) computes the pooled counts above from the stored runs, which are not in this repository.
