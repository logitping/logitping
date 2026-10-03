# Fingerprint bank maintenance

[Back to README](../README.md) · [Current bank](bank.md) · [Methodology](methodology.md)

Run maintainer commands from a source checkout. Links to scripts, configuration, and CI below also refer to the source checkout; these source files are not included in npm tarballs. `bank:check` makes no provider requests; `bank:update` makes paid requests and can replace the bundled bank. These commands are not needed for the Quickstart. For `lping bank-create`, install the CLI with `npm install -g logitping` or use `node dist/bin/logitping.js bank-create` from the checkout.

## Create a measured bank

Collect repeated runs from independently trusted reference endpoints, under the exact same probe template, sample budget, language, transport, CLI settings, and sampling temperature as the endpoint under test. Use a pinned backend version when possible. Preserve source provenance and collection dates outside the model's self-report. Use separate training, threshold-calibration, and final evaluation sets, including unenrolled model families and perturbed environments.

The offline utility accepts JSON with this shape; each placeholder below denotes a complete numeric array of 512 collected integers. `targetSamples` must be between 64 and 16,384: the sequential test reaches no decision before 64 integers, so `createFingerprintBank()` and bank validation reject calibrated banks below that (`MIN_SEQUENTIAL_SAMPLES`). Collection-only banks without calibrated models may use smaller budgets.

```ts
const enrollment = {
  source: 'Collection source, date, trusted identity evidence, and configuration',
  protocol: {
    id: 'integer-v1', language: 'en', targetSamples: 512,
    temperature: null, transport: 'openai',
  },
  checkpoints: [64, 128, 256, 512],
  nuisanceDirections: [], // optional; directions in sqrt feature space
  models: [
    {
      id: 'reference-model-a', family: 'reference-family-a',
      training: [/* at least 3 independent runs, each a number[] */],
      validation: [/* at least 2 separate runs, each a number[] */],
    },
    // Enroll at least one competing reference to support identification.
  ],
};
```

```sh
lping bank-create --input enrollment.local.json --output bank.local.json
```

The library equivalent is `createFingerprintBank(enrollment)`. It pools training counts for categorical probabilities, averages feature centroids per checkpoint, estimates projected feature variances with the shrinkage described in [Methodology](methodology.md), and sets distance envelopes from the maximum held-out distances plus a 10% margin and numerical floor. These are empirical envelopes, not a statistically certified OOD coverage guarantee. If a genuine run is exchangeable with the `n` held-out runs, it exceeds their maximum with probability about `1/(n + 1)` per statistic before the margin: 33% at the two-run minimum, 17% with five runs. Both the Hellinger and Mahalanobis gates apply, so the false-reject rate can approach twice that. About 19 held-out runs give a nominal 5% per statistic. Three training and two validation runs are structural minimums, not recommended production sample sizes. The code cannot establish that supplied labels are trustworthy or that runs are independent.

Generated banks set `sequentialValidated: false`. Evaluate false positives and false negatives on independent streams, OOD families, drift conditions, and every prefix used for stopping. Only after that validation should the bank owner set this field to `true`. Check the bank's calibration and provenance fields; the [current bundled bank](bank.md) contains measured references, with sequential early stopping disabled.

## Updating the fingerprint bank

The [update script](../scripts/update-bank.mjs) collects new `integer-v1` responses and passes separate training and held-out validation arrays to `createFingerprintBank()`. Each model is requested through one of two providers, chosen by `provider` in the configuration (default `cloudflare`, overridable per model):

- **Cloudflare AI Gateway** (`cloudflare`): Cloudflare's [REST endpoints](https://developers.cloudflare.com/ai-gateway/usage/rest-api/) with `Authorization: Bearer <Cloudflare API token>` and a `cf-aig-gateway-id` header.
- **OpenRouter** (`openrouter`): `https://openrouter.ai/api/v1` with `Authorization: Bearer <OpenRouter API key>`, using its [Chat Completions](https://openrouter.ai/docs/api/reference/overview), [Responses](https://openrouter.ai/docs/api/reference/responses/overview), and Anthropic-compatible Messages endpoints.

One bank may mix both, for example to add an OpenRouter-only model to a bank collected through Cloudflare. Each model's provenance names the provider that actually collected it. Every bank-update request sends `stream: false` and `Accept: application/json`, and waits for a complete JSON response before parsing integers. Each model selects Chat Completions, Responses, or Anthropic Messages via `apiFormat`; all receive the same single-user integer prompt. Banks use the `api` transport label (a config may still say `openai`, the legacy name), so both HTTP providers can use them, and each model's provenance records its actual API format and non-streaming mode. Validate transfer across API formats, streaming modes, and providers before relying on the bank; this does not calibrate the different system prompts used by local CLI drivers.

Set these environment variables, or put the corresponding fields in a private `*.local.json` config file. Only the credentials of providers that the configured models use are required and validated. Environment values take precedence over file values; credentials are never written to the generated bank or checkpoint.

For local setup, copy [`.env.example`](../.env.example) to `.env`, fill in the values for your providers, and follow its shell instructions to export them. The update script does not load `.env` automatically.

| Environment variable | Optional JSON field | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | `gateway.accountId` | 32-character hexadecimal account ID |
| `CLOUDFLARE_GATEWAY_ID` | `gateway.gatewayId` | Gateway ID/name; `CLOUDFLARE_GATEWAY_NAME` is an environment alias |
| `CLOUDFLARE_API_TOKEN` | `gateway.apiToken` | Cloudflare token scoped to the account with **Account → Workers AI → Read** |
| `OPENROUTER_API_KEY` | `openrouter.apiKey` | OpenRouter API key (`sk-or-…`), required only for `openrouter` models |
| `LOGITPING_BANK_CONFIG` | — | Alternative config path; overridden by `--config` |

For Cloudflare's REST endpoint, an AI Gateway-only token is insufficient. Configure the account's billing or stored provider credentials for the selected models; the script does not collect upstream provider keys. Cloudflare's [credential and billing rules](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) determine whether default stored keys or Unified Billing are used. Use a gateway whose routing and transformations you control.

OpenRouter bills requests to the key's account. By default it [load-balances each request across the upstream providers](https://openrouter.ai/docs/guides/routing/provider-selection) that host a model and falls back to another on errors. The updater sends no provider preferences, so runs of one model can be served by different hosts, and account-level routing settings still apply. Provenance records the requested OpenRouter route, not the host that served each run. This matters most for open-weight models, whose hosts can differ in quantization.

```sh
# Set the credentials for the providers your config uses in your shell or secret manager first.
# Build, validate config/credentials, and print the request budget without API calls:
npm run bank:check

# Collect and atomically replace src/data/default_bank.json:
# If interrupted, rerun the same command to resume saved runs.
npm run bank:update

# Deliberately discard saved progress and collect an entirely new bank:
npm run bank:update -- --restart

# After adding models to the config, collect only those and merge them into the bank:
npm run bank:check -- --incremental
npm run bank:update -- --incremental

# Use a private config and a different destination:
npm run bank:update -- --config bank-update.local.json --output bank.local.json

# Rebuild to embed the new default bank in the published library and CLI:
npm run check
```

Edit [`config/bank-update.json`](../config/bank-update.json) to select catalog models; the checked-in configuration routes every model through OpenRouter (`"provider": "openrouter"`), so it needs only `OPENROUTER_API_KEY`. The current configuration requests 13 models, 512 integers per run, 10 training runs and 5 held-out runs per model: **195 complete runs**, with a hard cap of **300 requests** including retries. Each run allows up to five retries, so the current request cap leaves room for at most **105 retry requests** across a full refresh. Every entry explicitly allows 8,192 output tokens per request, leaving room for reasoning before the integer answer. The requested output budget is **1,597,440 tokens** without retries; the dry run reports a conservative upper bound of **2,457,600 tokens** including the retry allowance, plus prompt tokens. These are request limits, not a measured cost estimate. Availability and actual usage depend on the account and model. Prefer pinned model versions when the catalog offers them.

Collection resumes automatically from `<output>.checkpoint.json` (normally `src/data/default_bank.json.checkpoint.json`). Each valid run is saved atomically, and the directory is synced so the save survives power loss, before progress is reported or another request begins. After a failure or Ctrl+C, run the same command: completed training and validation runs are reused, and collection continues with the first unfinished run. The log reports how many runs were restored and how many requests remain in the budget. The final bank is still replaced only after every run and calibration succeeds. A complete checkpoint can also retry a failed publication without API calls; it is removed after successful publication so the next update collects a fresh bank.

Just before publishing, the updater writes the accepted runs to `<output>.corpus-<sha256>.json`, which Git ignores. The file name is the corpus digest recorded in each collected model's provenance; hashing the file's `protocol`, `checkpoints`, and `models` reproduces it. Keep the file to refit the bank without new requests after a change to enrollment, such as the variance estimator. An incremental update writes only the runs it collected; retained models point to the corpus of their own collection.

The request cap applies across all resumes of a collection. Attempts are recorded **before** contacting the provider, including failed, timed-out, and interrupted requests. An interrupted request with no saved result may need repeating and remains charged against the cap; even a crash just before sending is conservatively counted. The automatic `maxProbeRetries` allowance applies to each unfinished run in the current invocation, while `maxRequests` never resets on resume. If the remaining cap cannot cover the unfinished runs, the updater stops before sending anything. You can explicitly raise `maxRequests` to continue; changing timeout, request delay, retry allowance, or API token/key also preserves progress.

Checkpoint validation prevents mixing incompatible collections: model order/routes, providers, API formats, token limits, run counts, protocol, exact prompt, calibration checkpoints, and, when any collected model uses Cloudflare, account/gateway must match. Checkpoints saved before OpenRouter support still resume. Restore those settings to resume, choose another `--output`, or use `--restart` to discard the saved collection and reset its budget. A corrupt checkpoint is never silently discarded. `--dry-run`, including with `--restart`, validates the full configuration and reports its budget without inspecting or changing saved progress or making requests; with `--incremental` it also reads the output bank to report which models it would collect.

### Incremental updates

`--incremental` compares the configured models with the bank at `--output` and collects probes only for the models it lacks, then merges them into that bank. A model is kept, byte for byte and without requests, only if the bank enrolls it as calibrated under the same `id`, `family`, protocol, and calibration checkpoints, and its provenance records the configured route, API format, run counts, sample count, and token limit field. Changing only `maxTokens` does not trigger collection either; accepted runs were complete replies, and the provenance keeps the limit they were collected with. Switching a model's `provider` alone does not trigger collection: the same catalog route is treated as the same model, so moving the configuration from Cloudflare to OpenRouter keeps every enrolled model without requests. Such models keep their original provenance; the plan lists them as enrolled through another provider, and a full update re-collects them through the configured provider. Everything else configured is collected: new models, uncalibrated placeholders, and entries whose settings changed (a new route or run count, for example). If the protocol or checkpoints changed, that means every model. Bank models no longer in the configuration are dropped. The merged bank follows configuration order, keeps the bank's nuisance directions (new models are calibrated with them), counts held-out runs across all models, and sets `sequentialValidated: false`. Each model's provenance still records its own collection time and corpus digest. The bank-level calibration source describes the merge.

Required runs, the retry allowance under `maxRequests`, and the checkpoint cover only the models being collected; the dry run prints that plan. The configuration must still fit a full collection within `maxRequests`. When nothing needs collecting or removing, the bank and any saved progress are left untouched. Removing models without collecting any rewrites the bank without requests. Incremental mode needs a valid existing bank; it never falls back to a full collection. A checkpoint resumes only for the model set it was saved for. For example, a full run refuses an unfinished incremental collection of a subset; resume it with `--incremental` or discard it with `--restart`. The final comparison against concurrent edits also protects the bank being merged into. Retained models were collected earlier and possibly through another gateway, so run a full update when upstream behavior may have drifted.

Checkpoint files contain only validated integer samples, collection time, counters, and a configuration digest; they exclude credentials, raw responses, and reasoning. They are private files (mode `0600`) and ignored by Git. Keep the checkpoint beside its output file between invocations. Resume assumes the configured providers and catalog routes still represent the same models; start fresh if their upstream behavior has changed.

Configuration fields:

| Field | Behavior |
| --- | --- |
| `schemaVersion` | Must be `1` |
| `protocol` | `id: "integer-v1"`, `language: "en"` or `"zh"`, `targetSamples: 64..16384`, `temperature: null` or `0..2`; transport is `api` (legacy `openai` is accepted) |
| `checkpoints` | Sorted, unique prefix counts, at least 64, ending at `targetSamples`; defaults to the full sample count |
| `trainingRuns`, `validationRuns` | Defaults 10 and 5; minimums 3 and 2, maximum 100 each |
| `provider` | `cloudflare` (default) or `openrouter`: the service that relays each model's requests |
| `models` | 2–32 entries with unique `id`, `family`, and a catalog `model` for its provider; a route may appear once per provider |
| `model` | Cloudflare: a catalog identifier such as `openai/gpt-6-sol` or `@cf/…`; `dynamic/` routes are rejected. OpenRouter: `author/slug`, optionally with a variant such as `:free` or `:thinking`; the `openrouter/auto` and `openrouter/free` routers, floating `~author/…` aliases, `@preset/…` routes, and `:online` variants (which add web search results to the prompt) are rejected |
| Per-model overrides | `provider`, `trainingRuns`, `validationRuns`, `maxTokens`, `apiFormat`, `tokenLimitField`, and `sampleCount` |
| `maxTokens` | Output-token limit for each request, default `sampleCount * 5 + 64`; includes reasoning tokens where applicable. The checked-in entries use 8192 to leave room for reasoning and the integer answer |
| `apiFormat` | `chat-completions` (default), `responses`, or `messages`; selects the provider endpoint and JSON response format |
| `tokenLimitField` | Chat Completions: `max_tokens` (default) or `max_completion_tokens`; Responses: `max_output_tokens` only (default); Messages: `max_tokens` only (default) |
| `sampleCount` | May be written explicitly per model, but must equal the shared `protocol.targetSamples`; use separate banks for different protocols |
| `timeoutMs` | Per-request deadline, default 120000, maximum 600000 |
| `requestDelayMs` | Delay between requests, default 1000, maximum 60000 |
| `maxRequests` | Hard cap across all resumes, including failed/interrupted requests; default 100, maximum 1000; enough budget is reserved for every unfinished run |
| `maxProbeRetries` | Shared retries per run for normally completed replies with short or invalid integer output; default 0, maximum 5; checked-in config uses 5, subject to `maxRequests` |
| `maxShortResponseRetries` | Legacy alias for `maxProbeRetries`; now covers invalid integer output too. If both fields are supplied, their values must agree |

All configuration is checked before paid requests begin. Models alternate within training and then validation rounds; validation uses newly requested responses. Prompts exactly match `integer-v1`, without nonce text or tokenizer challenges. Collection never uses the existing bank to classify responses or stop early; incremental updates read it only to decide which models to collect and to merge the results.

The checked-in Astra entry uses `max_completion_tokens`, matching [Cloudflare's Chat Completions example](https://developers.cloudflare.com/ai/models/openai/gpt-6-astra/). GPT-5.6 Sol uses Responses; Claude Fable 5.1 and Opus 5 use Messages. Check each model's supported request formats in the provider's catalog when adding entries. Output token budgets can include reasoning tokens. A dry run validates local configuration, not model access, quota, or whether a live model will complete all requested integers.

A reply cut off at the requested output limit (`finish_reason: "length"`, Responses `incomplete_details.reason: "max_output_tokens"`, or Messages `stop_reason: "max_tokens"`) fails with "Probe response hit the output token limit", naming the provider's stop code and the `maxTokens` value used. Reasoning and answer tokens share that limit; see [Anthropic's token-budget guidance](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost#cost-control) for Claude. Any other abnormal stop fails with "Probe response did not finish normally" and the stop code, such as `finish_reason=content_filter` or `status=incomplete; reason=content_filter`; codes that are not short identifiers are reported as `unrecognized`, never echoed. Increase that model's `maxTokens` in the configuration if it still truncates, then check the updated budget with `npm run bank:check`. Truncated output is rejected even if it contains enough integers; the updater does not automatically raise the limit or retry the same capped request.

HTTP failures include recognized parameter hints and provider error codes from bounded JSON responses; arbitrary provider messages, headers, and response bodies are never echoed. HTTP 429 reports rate/quota guidance and a numeric `Retry-After` when available. The updater stops on that failure and does not automatically retry or raise account limits.

Cloudflare requests set `cf-aig-skip-cache: true` and `cf-aig-max-attempts: 1`; see Cloudflare's [cache bypass controls](https://developers.cloudflare.com/ai-gateway/features/caching/). OpenRouter requests set `X-OpenRouter-Cache: false`, which also overrides presets that enable [response caching](https://openrouter.ai/docs/guides/features/response-caching). Reported cache hits from either provider are rejected. Each training and validation run uses the first `targetSamples` integers in order, matching normal probes. If a model emits extra valid integers, those do not enter the bank. The updater validates the entire assistant output and requires a normal completion status (`stop`, `completed`, or `end_turn`, according to the API). Reasoning, tool output, and usage metadata are excluded.

A normally completed response with too few integers, an out-of-range value, or malformed integer output may be retried within `maxProbeRetries` and `maxRequests`. For example, a 511-integer reply to a 512-integer probe, or a reply containing `356`, is discarded and replaced with a fresh request using the same prompt and settings. Invalid values are never clamped or skipped; short replies are never padded or joined to another reply. Accepted training and held-out run counts stay unchanged. Short and invalid replies share one retry allowance per run, including invalid output after the retained prefix. Retries honor the request delay and cancellation signal. The updater stops as soon as the remaining request budget cannot cover every unfinished run. Progress logs include the rejection reason and invalid token position without arbitrary model text. Bank provenance records short and invalid response counts by phase; fitted envelopes therefore describe responses that satisfy the integer protocol, and rejection rates should be included in independent evaluation.

HTTP errors, malformed or oversized JSON (over 16 MiB), unexpected SSE, missing completion status, refusals, length-limited output, timeouts, and cancellation stop the current invocation without automatic retries. Exhausting the probe retry allowance also stops collection. Completed runs stay in the checkpoint for a later resume, and the previous bank remains intact. Equal sequences are not deduplicated: identical outputs can occur legitimately and do not by themselves establish caching or independence.

The bank is validated, written to a temporary sibling file, synced, and atomically renamed only after collection and calibration succeed. An output lock prevents overlapping collection, and a final comparison protects edits made during collection. Failures preserve the old bank. SIGINT/SIGTERM abort collection and remove the lock; after a forced kill, remove a stale `.lock` only after verifying that no updater is running. Byte-identical output is not rewritten. Collection timestamps are provenance, so a fresh collection can change provenance even if fitted values happen to match.

Provenance includes the provider, collection time, requested catalog model, API format, `stream=false`, accepted run counts, short and invalid response counts for each phase, retry limit, fixed-prefix sampling policy, token-budget field, variance estimator (`variance=block-median-shrinkage-v1`), and a SHA-256 digest of the retained corpus. Models enrolled before the variance estimator was recorded keep their earlier, unregularized variances until a full update re-collects them; an incremental update retains them as they are. Account IDs, gateway names, tokens, API keys, and raw responses are excluded. Labels reflect the requested catalog routes, not independent model identity attestation. As with manual enrollment, the fitted envelopes are empirical; sequential early stopping stays disabled until independently evaluated.

### GitHub Actions

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs type checks, tests, builds, and package checks on Node.js 22 and 24 for pushes and pull requests. On Node.js 24, it also builds and runs `bank:check` under Node.js permission restrictions using a synthetic OpenRouter fixture. The `OPENROUTER_API_KEY` value in that step is a placeholder required by configuration validation; the dry run sends no provider requests and needs no repository secrets.

Fingerprint bank updates are run manually with `npm run bank:update`; no GitHub Actions workflow collects probes or opens bank-update pull requests.
