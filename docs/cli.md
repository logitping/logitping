# CLI reference

[Back to README](../README.md) · [Transport limitations](transports.md)

The examples below use `lping` after `npm install -g logitping`. From a source checkout, replace `lping` with `node dist/bin/logitping.js`. The [Quickstart](../README.md#quickstart) includes a complete OpenRouter example.

```sh
# Interactive connection and bank selection in a terminal
lping

# Reuse an existing CLI login
lping --driver claude
lping --driver codex

# OpenAI-compatible API: root URL, /v1, or full /v1/chat/completions URL
export LOGITPING_API_KEY='your-key'
lping --endpoint https://api.example.com/v1 --model claimed-model

# Anthropic Messages API
lping --provider anthropic --endpoint https://api.anthropic.com --model claimed-model

# Reasoning models spend output tokens before answering: raise the budget, or use Responses
lping --endpoint https://api.example.com/v1 --model claimed-model --max-tokens 8192
lping --endpoint https://api.example.com/v1 --model claimed-model --api-format responses --max-tokens 8192

# A measured, protocol-matched bank
lping --endpoint https://api.example.com/v1 --model claimed-model --bank ./bank.local.json
lping --driver codex --bank ./codex-bank.local.json

# Experimentally compare Codex samples against the bundled API bank
lping --driver codex --allow-transport-mismatch

# Collect data without early stopping; JSON includes the parsed samples
lping --driver claude --no-early-stop --samples 512 --json > run.local.json

# Stream incoming model text to stderr; JSON stays on stdout
lping --driver claude --stream --json
```

API keys are read in this order: `--key` or `--key-file`, `LOGITPING_API_KEY`, then `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. The vendor variables are sent only to the vendor's own host (`api.openai.com` or `api.anthropic.com`) over HTTPS, even with `--allow-insecure-http`, and never to a third-party endpoint under test; use `LOGITPING_API_KEY`, `--key-file`, or `--key` for any other endpoint. Prefer `--key-file <path>` (a file or pipe holding only the key, at most 4 KiB, such as `--key-file <(pass show api-key)`; surrounding whitespace is trimmed) or environment variables over `--key`, which may appear in shell history and process listings. Credential options are not serialized into bank files or ordinary result fields. Review raw tokenizer responses, streamed text, and custom-transport output before sharing; arbitrary provider text is not guaranteed to be free of secrets. No key is required for an unauthenticated local endpoint.

By default, without `--bank`, the bundled bank is used for identification only when its transport matches the selected connection. The bundled OpenRouter bank has transport `api`: it was collected through non-streaming Chat Completions, Responses, and Anthropic Messages. The engine permits comparisons with both `--provider openai` and `--provider anthropic`; transfer across providers, streaming modes, and API formats still needs independent evaluation. See the [current bank](bank.md). `lping --driver codex` and `lping --driver claude` collect samples and return `UNCALIBRATED` (exit code 2), with no model ranking or confidence. Their output explains the missing calibration; this is a completed collection, not a transport error. The same behavior applies to the library when `fingerprint()` is called without an explicit bank.

To identify models through Codex under a matching calibration, supply a bank enrolled from independent Codex driver runs with `protocol.transport: "codex"` and `temperature: null`; see [enrollment](bank-maintenance.md#create-a-measured-bank). Local CLI prompts and settings can change the output distribution, so API measurements do not establish calibration for those drivers. By default, an explicit `--bank` must match the transport, language, sample budget, and temperature. Mismatch errors report the differing values before starting a probe.

Use `--allow-transport-mismatch` to opt into comparing Codex output against API reference fingerprints. It works with the bundled bank or an explicit `--bank` and also supports other transport pairs. Only the transport restriction is relaxed: language, sample budget, and temperature must still match; CLI drivers require a bank with `temperature: null`. Collection requires the full requested sample count and disables early stopping, even if the reference bank was sequentially validated. The bank itself is unchanged.

A reference match in this mode returns `HEURISTIC_MATCH`, the candidate in `model`, and `confidence: null`. Reference weights and distances appear in `scores`; these are exploratory comparisons, not measured identity probabilities or validated cross-transport acceptance thresholds. JSON includes `crossTransport` with the probe and bank transport names. Missing separation or rejected reference envelopes still produce `INCONCLUSIVE` or `UNKNOWN_MODEL`; a short reply is `INCONCLUSIVE`. All these results use exit code 2. In library calls, enable this with `fingerprint(transport, { allowTransportMismatch: true })`.

Other options: `--language en|zh`, `--samples 4..16384`, `--temperature 0..2` (API only), `--timeout <ms>` (120000 by default), `--tokenizer`, `--no-early-stop`, and `--no-interactive`. See `--help` for all options. The timeout covers collection, including the optional tokenizer stage; no single request is cut off earlier. A custom transport must also finish its iterator cleanup; see the [library contract](library.md#custom-transports).

`--max-tokens <n>` sets the output-token budget of the integer request (API only). The default, samples × 5 + 64, is 2,624 tokens for 512 integers. Reasoning models spend part of the budget before answering, so a reply can stop short of the requested integers; the result is then `INCONCLUSIVE`, and its reason names the limit. Each bundled reference records its collection budget in provenance; the current bank used 8,192 output tokens per request. Match that budget when reproducing the current reference setup. Only complete replies were accepted, so changing the budget can change which replies satisfy the protocol. `--api-format responses` selects the OpenAI Responses API instead of Chat Completions. `--token-limit-field` overrides the budget field: `max_tokens` (default) or `max_completion_tokens` for Chat Completions; Responses uses `max_output_tokens`.

HTTPS is required except for localhost. Use `--allow-insecure-http` to explicitly enable a remote HTTP endpoint. Redirects are rejected so authentication headers cannot move to another endpoint. Probes are not retried automatically: retries could duplicate cost and bias observations.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Identified under the supplied bank and nominal statistical assumptions; or a successful utility command |
| 1 | Invalid configuration, transport failure, or malformed model output |
| 2 | `HEURISTIC_MATCH`, `UNKNOWN_MODEL`, `INCONCLUSIVE`, or `UNCALIBRATED` |
| 130 | Interrupted by SIGINT or SIGTERM, or interactive selection cancelled |

An interrupted probe stops its CLI or request, removes its temporary directory, and then reports the interruption; a second signal exits immediately.

With `--json`, every failure, including an invalid command-line argument, prints `{"status": "ERROR", "error": "…"}` on stdout. When available, it also carries `code`, the `LogitpingError` code (see [Library](library.md)) or `TIMEOUT` when the probe deadline passed, and `httpStatus` for `HTTP_STATUS` failures. Argument and configuration errors have no `code`, except that an unusable `--bank` file reports `INVALID_BANK`.

`UNKNOWN_MODEL` means the observation falls outside all enrolled distance envelopes. It does not name an unseen model, and could also indicate parameter or environment drift. `INCONCLUSIVE` means the available evidence cannot support identification. An uncalibrated bank returns `UNCALIBRATED`, with no confidence or candidate ranking.
