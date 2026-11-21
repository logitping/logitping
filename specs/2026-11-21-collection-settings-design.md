# Per-model collection settings in the bank: design

Status: implemented on 2026-11-21 as item 4 of the 0.8.0 plan; see the erratum for changes from the final review.

## Context

Each bank model's output budget, API format, token-limit field and requested route exist only inside its `provenance` string, for example `…; model=gpt-6.1-sol; api=responses; stream=false; …; max_output_tokens=8192; …`.

- **The probe cannot use them.** The CLI defaults to `samples × 5 + 64` output tokens (2,624 for 512 integers, 384 for a pooled request), so reasoning models are cut off and end `INCONCLUSIVE` unless the user passes the right `--max-tokens`. `docs/bank.md` lists those budgets by hand: 8,192, 16,384, 32,768 or 65,536 depending on the model.
- **The format is uniform.** On 2026-11-21, all 36 bundled entries (18 per bank) were read: every one records the provider label, `model=`, `api=`, `stream=false`, run counts, `sampling=`, the token-limit field and its value, `collected`, and `corpus sha256:` in the same format. So the settings can be filled in from provenance without new requests.

## Decisions

| Topic | Decision |
| --- | --- |
| Bank field | `ModelFingerprint.collection?: CollectionSettings`: `{ provider, route, apiFormat, tokenLimitField, maxTokens, collectedAt, corpusSha256 }`. It is optional and additive: the schema version does not change, and older readers ignore it, because `validateBank` checks known fields and copies the rest. |
| Values | `provider`: `openai`, `openrouter`, `google` or `cloudflare`, from the provenance label. `route`: the requested model, such as `anthropic/claude-sonnet-5.5`. `apiFormat`: `chat-completions`, `responses` or `messages`. `tokenLimitField` and `maxTokens`: the budget field and value sent. `collectedAt`: ISO time. `corpusSha256`: 64 hex digits. |
| Validation | Present only as a whole. `tokenLimitField` must fit `apiFormat`: `max_output_tokens` for `responses`, `max_tokens` for `messages`, and `max_tokens` or `max_completion_tokens` for `chat-completions`. `maxTokens` must be an integer from `targetSamples` to 262,144, the updater's bound. A violation is `INVALID_BANK`. |
| Filling | The updater's `enroll()` writes `collection` from the configuration of each model it collects. Incremental `merge()` and the pooled refit fill a missing `collection` from provenance through `parseCollectionSettings`. The two bundled banks are filled once, with no other content of either file changing. A test pins, for both bundled banks, that `collection` equals `parseCollectionSettings(provenance)` for every model. |
| Reuse rule | Unchanged: `enrolledAs` still compares provenance. |
| Matching a probe | In API mode, `--model` names an enrolled model when its last `/`-separated segment equals a bank model's `id`, ignoring case. So `openai/gpt-6.1-sol` and `gpt-6.1-sol` both name `gpt-6.1-sol`. |
| Applied automatically | For a matching model, the CLI applies these unless given on the command line: the recorded `--max-tokens`; and `--token-limit-field`, but only when the probe's wire format is the recorded one. |
| Not applied | `--provider` and `--api-format`. An endpoint's support and authentication differ by host. For example, the bank's Claude references came through OpenRouter's Messages endpoint with Bearer authentication, while the CLI's Anthropic format sends `x-api-key`. So when the probe's format differs from the recorded one, the CLI notes on stderr which flags would match it, and changes nothing. |
| Notes | stderr only, so `--json` output stays clean, in this form: `Note: using <id>'s collection settings from the bank: --max-tokens 8192.` |
| Library | `collectionSettingsFor(bank, model): { id, collection } \| undefined` is exported. `fingerprint()` does not apply settings, so library users pass them to `HttpClient` and `fingerprint()`. |
| Drivers | Not affected: CLI drivers take no budget or format. |
| Evaluation | Both banks' bytes change, so `docs/evaluation.json` and `docs/evaluation.md` are regenerated. Every count must stay identical. |

## Documentation changes

Fixed copy.

**`README.md`, Quickstart: replace "using the Responses format and 8,192 output-token budget recorded in its reference fingerprint." with:**

> using the Responses format recorded in its reference fingerprint. Because `--model` names an enrolled model, the CLI also applies the 8,192-token output budget it was collected with.

**`README.md`, Quickstart command: delete the line `  --max-tokens 8192 \`.**

**`docs/bank.md`: replace the paragraph that begins "The probe CLI defaults to 2,624 output tokens for 512 integers." with:**

> Each model entry records its collection settings in `collection`: the provider, requested route, API format, token-limit field, output budget, collection time and corpus digest. When `--model` names an enrolled model, as `openai/gpt-6.1-sol` names `gpt-6.1-sol`, the CLI applies its recorded `--max-tokens`, and its `--token-limit-field` when the probe uses the recorded API format, unless you pass them yourself. A smaller budget can truncate reasoning models before all integers arrive. The CLI does not switch `--provider` or `--api-format`, because endpoints differ in what they support and how they authenticate; it notes the flags that would match the recorded format. Matching the budget and format does not establish transfer across hosts or streaming modes.

**`docs/cli.md`: insert before the paragraph that begins "By default, without `--bank`":**

> When `--model` names a model enrolled in the bank in use, ignoring any `vendor/` prefix and letter case, the CLI applies the output budget the model was collected with as `--max-tokens`. When the probe uses the recorded API format, it also applies the recorded `--token-limit-field`. Options you pass yourself always win. It prints a `Note:` on stderr naming what it applied. If your `--provider` or `--api-format` differs from the recorded format, the note names the flags that would match it; the CLI does not change them.

**`docs/library.md`: append to the paragraph that begins "Pass `maxTokens` to `fingerprint()`":**

> `collectionSettingsFor(bank, model)` returns the settings an enrolled model was collected with: `maxTokens`, `apiFormat`, `tokenLimitField`, the requested `route` and the collection `provider`. It returns `undefined` for a model the bank does not enroll. The library does not apply them; pass them to `HttpClient` and `fingerprint()` yourself.

**`docs/bank-maintenance.md`: append to the paragraph that begins "Provenance includes the provider":**

> The updater also records each collected model's provider, route, API format, token-limit field, output budget, collection time and corpus digest in a structured `collection` field. A retained or refitted model that lacks it gets it from its provenance.

**`CHANGELOG.md`: under `## Unreleased` → `### Added`, add:**

> - Each bank model records its collection settings in a structured `collection` field: provider, requested route, API format, token-limit field, output budget, collection time and corpus digest. Both bundled banks have it, filled from their provenance without new requests. When `--model` names an enrolled model, the CLI applies its recorded output budget, and its token-limit field when the API format matches, unless given; it notes, but does not change, a different `--provider` or `--api-format`. `collectionSettingsFor()` exposes the settings to library users.

**`src/cli.ts`: the `--max-tokens` help text becomes:**

> output token budget per integer request (default: the budget the bank recorded for --model, otherwise samples × 5 + 64); reasoning models need more

## Erratum (2026-11-21, final review)

- **`docs/cli.md` budget paragraphs.** Its `--max-tokens` and `--pooled` paragraphs, which the copy above left out, still gave samples × 5 + 64 as the default and listed budgets to pass by hand. They now describe the recorded default.
- **Applied-settings note.** It now ends "Pass them yourself to override; a large budget can also need a longer --timeout." An applied budget of up to 65,536 can outlast the 120 s default timeout, where the old default stopped quickly as `INCONCLUSIVE`.
- **Anthropic Messages note.** It now reads "add --provider anthropic to match it, if the endpoint accepts Anthropic's x-api-key authentication." That flag changes the authentication header, which is this spec's own reason for not switching. `docs/cli.md` says the same.
- **`docs/library.md` copy.** It now states that `collectionSettingsFor` returns `{ id, collection }`, and that an `apiFormat` of `messages` means `provider: 'anthropic'` for `HttpClient`.
- **Changelog.** A "Changed" line tells existing users that an enrolled `--model` now gets the recorded budget by default.

## Out of scope

- Switching `--provider` or `--api-format` automatically.
- Applying settings inside `fingerprint()`.
- Moving `enrolledAs` or the evaluation's corpus roles from provenance to `collection`.
- Recording run counts, sampling or streaming in `collection`, since provenance still holds them.
