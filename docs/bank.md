# Bundled reference bank

[Back to README](../README.md) · [Methodology](methodology.md) · [Bank maintenance](bank-maintenance.md)

## Collection snapshot

This describes the checked-in bank: the 13 models of the experimental `0.2.1` npm release, whose bank is unchanged since `0.1.0`, plus `gemini-3.8-flash` and `gemini-4-argon` (family `gemini`), both collected on 2026-10-21 (UTC) and not yet released. The 13 earlier entries are byte for byte the released ones. The checked-in [bank](../src/data/default_bank.json) and its per-model provenance are the source of truth after any refresh. That source link requires a repository checkout; from an installed package, `defaultBank()` returns the bundled bank and its provenance.

| Setting | Value |
| --- | --- |
| Collection provider | OpenRouter (13 models); Google AI Studio directly, with no relay (`gemini-3.8-flash`, `gemini-4-argon`) |
| Collection timestamp | `2026-10-03T10:19:52.961Z` (13 models); `2026-10-21T12:49:38.534Z` (`gemini-3.8-flash`); `2026-10-21T23:38:01.740Z` (`gemini-4-argon`); all UTC |
| References | 15 calibrated model entries |
| Accepted runs | 10 training + 5 threshold-calibration runs per model; 225 total |
| Protocol | `integer-v1`, English, first 512 integers in `[1, 355]` |
| Transport | `api`; collection requests used `stream: false` |
| Temperature | Omitted (`null` in the bank) |
| Output-token limit | 8,192 per request, including reasoning where applicable; 32,768 for `gemini-4-argon` |
| Distance checkpoints | 64, 128, 256, 512 integers |
| Nuisance directions | None |
| Early stopping | Disabled: `sequentialValidated: false` |

`calibrated` means that empirical distance envelopes were fitted. The five runs called `validation` in the data are used to set those envelopes; they are not an independent final evaluation set. Model labels record requested catalog routes, not independently attested backend identities. OpenRouter routing can select different upstream hosts, and the bank does not record the serving host of each run. The Gemini requests went straight to Google's OpenAI-compatible Chat Completions endpoint.

`gemini-4-argon` used up an 8,192-token budget, which reasoning shares, before finishing its answer, so it was collected with 32,768 tokens, its maximum output. Even then, 10 of its 25 replies that ended were cut off at the limit before 512 integers. Those requests were sent again, and provenance does not count them, because the updater stops at a cut-off reply instead of retrying it. Two more Argon requests timed out and were sent again. Argon's references therefore describe only replies that finish within 32,768 tokens; expect a similar share of Argon probes to end `INCONCLUSIVE` with a short reply.

## Model list

Every entry except `gemini-4-argon` used the 8,192-token output limit above; Argon used 32,768. These are the routes and formats recorded at collection time, not a promise of ongoing catalog availability or access for every account. Routes with a vendor prefix were requested through OpenRouter; the two Gemini models were requested from Google AI Studio.

| Bank model ID | Requested route | API format | Token-limit field |
| --- | --- | --- | --- |
| `gpt-6.1-sol` | `openai/gpt-6.1-sol` | `responses` | `max_output_tokens` |
| `gpt-6-sol` | `openai/gpt-6-sol` | `responses` | `max_output_tokens` |
| `gpt-6-luna` | `openai/gpt-6-luna` | `responses` | `max_output_tokens` |
| `gpt-6-astra` | `openai/gpt-6-astra` | `chat-completions` | `max_completion_tokens` |
| `gpt-5.6-luna` | `openai/gpt-5.6-luna` | `responses` | `max_output_tokens` |
| `gpt-5.6-terra` | `openai/gpt-5.6-terra` | `responses` | `max_output_tokens` |
| `gpt-5.6-sol` | `openai/gpt-5.6-sol` | `responses` | `max_output_tokens` |
| `claude-sonnet-5.5` | `anthropic/claude-sonnet-5.5` | `messages` | `max_tokens` |
| `claude-opus-5.5` | `anthropic/claude-opus-5.5` | `messages` | `max_tokens` |
| `claude-fable-5.1` | `anthropic/claude-fable-5.1` | `messages` | `max_tokens` |
| `claude-opus-5` | `anthropic/claude-opus-5` | `messages` | `max_tokens` |
| `claude-sonnet-5` | `anthropic/claude-sonnet-5` | `messages` | `max_tokens` |
| `claude-fable-5` | `anthropic/claude-fable-5` | `messages` | `max_tokens` |
| `gemini-3.8-flash` | `gemini-3.8-flash` | `chat-completions` | `max_tokens` |
| `gemini-4-argon` | `gemini-4-argon` | `chat-completions` | `max_tokens` |

The probe CLI defaults to 2,624 output tokens for 512 integers. Use `--max-tokens 8192` to match this bank's collection limit, or `--max-tokens 32768` for `gemini-4-argon`; a smaller budget can truncate reasoning models before all integers arrive. Matching the budget and format does not establish transfer across hosts or streaming modes.

## Evaluation status

There is no published independent estimate of real-model identification accuracy, unknown-model error rates, or latency savings. Keep early stopping disabled until independent sequential evaluation supports enabling it.

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

The 13 OpenRouter models reference the corpus with digest:

```text
163709a6a44653bd0d9e12ab6114687305487845428dfcb163e57f0ab17fe225
```

`gemini-3.8-flash` and `gemini-4-argon` each reference a separate corpus, with digests:

```text
ccf4eb2395577f019a6fc45cc8295ba647e7babd269ed52ed6c51945069c2d06  gemini-3.8-flash
a1dcbf342056bf36db7dfa24d1b3b3a2844d51b486cf001c1c098b90e600e0e3  gemini-4-argon
```

Each digest is SHA-256 over UTF-8 `JSON.stringify({ protocol, checkpoints, models })` in that property order, using the corpus fields. It is not the digest of the entire file: the file also includes `schemaVersion`, `collectedAt`, and a trailing newline.

During the release review, the matching local corpus reproduced the digest and every fitted `integerProbabilities` and `profiles` field through `createFingerprintBank()`. Each Gemini corpus does the same for its entry. The corpus is currently a Git-ignored maintainer file; it is not distributed in this repository or npm tarballs, and no public download is available yet. External users therefore cannot currently reproduce these diagnostics from the repository alone. Publishing reviewed data, its usage terms, and an evaluation recipe remains release follow-up work.

Maintainers with the matching corpus can reproduce the diagnostic from the repository root after building. Replace `CORPUS_PATH` with the local corpus path, and run it once per corpus; this command only reads local data and performs no provider requests:

```sh
CORPUS_PATH=./src/data/default_bank.json.corpus-163709a6a44653bd0d9e12ab6114687305487845428dfcb163e57f0ab17fe225.json node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { defaultBank, fingerprint } from './dist/index.js';

const corpus = JSON.parse(readFileSync(process.env.CORPUS_PATH, 'utf8'));
const bank = defaultBank();
const totals = { full: {}, excluded: {} };
for (const model of corpus.models) {
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

`--pooled` (library: `pooledBank()`) uses a second bundled bank, `src/data/pooled_bank.json`. It covers the 13 OpenRouter models, not the Gemini models, collected through OpenRouter on 2026-10-11 without streaming: 25 training and 15 held-out runs of 64 English integers per model, with 4,096 output tokens per request. Its provenance records the corpus SHA-256, `4d34afe7497e9d0d83238136885022a808a5c0e6ecfcfc32b7ed5689131f0bbf`. Each probe sends 8 requests; see [methodology](methodology.md#experimental-pooled-probe-pooled-sets-v1).

Exploratory leave-group-out results on that collection. "Unenrolled" means the model was removed from the bank and its runs probed against the rest.

| Probe | Enrolled model named wrongly | Unenrolled model named | `gpt-6.1-sol` / `gpt-6-astra` named correctly |
| --- | --- | --- | --- |
| 1 × 512 integers, default engine (fresh 512-integer collection) | 0/519 | 51/519 (10%) | 0/80 |
| 8 × 64 integers, pooled bank | 1/65 | 9/65 (14%) | 6/10 |

Treat these as exploratory:

- The pooled test was designed after the collection results were seen.
- The 8-request samples are small: 9/65 has a 95% interval of about 7–24%.
- The pooled mode did not meet the predeclared target of naming unenrolled models at most 10% of the time.
- Unenrolled models were named as similar models from the same vendor. In the pooled test, none was named as a model from another vendor.

The mode is therefore opt-in, and a single-model result is a `HEURISTIC_MATCH`.

Most pooled errors involve two pairs of models. To locate them, the pooled test was repeated with 10 different groupings of each model's 40 runs into 5 probes of 8, giving 50 probes per model. The first grouping is the one in the table above.

| Tested model | Bank | Named instead | Probes |
| --- | --- | --- | --- |
| `gpt-6-astra` | Without `gpt-6-astra` | `gpt-6.1-sol` | 48/50 |
| `gpt-6-luna` | Without `gpt-6-luna` | `gpt-6-sol` | 26/50 |
| Each other model | Without the tested model | A same-vendor model | 12/550 (2.2%) |
| `gpt-6-astra` | All 13 models | `gpt-6.1-sol` | 9/50 |
| Each other model | All 13 models | Any other model | 0/600 |

The confusion between `gpt-6-astra` and `gpt-6.1-sol` runs one way. With both models enrolled, `gpt-6-astra` was named as `gpt-6.1-sol` in 9 of 50 probes; `gpt-6.1-sol` was never named as `gpt-6-astra`. Removed from the bank, `gpt-6.1-sol` was named as `gpt-6-astra` in 2 of 50 probes. A `gpt-6.1-sol` result therefore does not rule out `gpt-6-astra`, while a `gpt-6-astra` result was not observed for `gpt-6.1-sol`.

The groupings reuse the collection that the bank was built from, so these counts show where errors concentrate, not how often they occur on new data. Three offline changes to the pooled test were tried on the same groupings: a novelty test on the pooled score, a fit test for each feature group, and a minimum lead over the second-best model. Those that lowered the unenrolled rate below 10%, to 7.5–9.5%, also cut correct single-model results for enrolled models from 73% to 34–62%. None was adopted.
