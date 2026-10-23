# logitping

[![npm version](https://img.shields.io/npm/v/logitping?logo=npm)](https://www.npmjs.com/package/logitping)
[![Node.js version](https://img.shields.io/node/v/logitping?logo=nodedotjs)](#install)
[![TypeScript types](https://img.shields.io/npm/types/logitping?logo=typescript)](docs/library.md)
[![License](https://img.shields.io/npm/l/logitping)](LICENSE)

<!-- Enable the CI badge once the repository and workflow are publicly accessible.
CI includes type checking, tests, builds, and package installation checks.
[![CI](https://github.com/logitping/logitping/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/logitping/logitping/actions/workflows/ci.yml)
-->

`logitping` (`lping`) is a Node.js CLI and TypeScript library for collecting LLM behavior samples and comparing them with measured reference fingerprints. Use it to investigate endpoint behavior, compare candidate models, and build your own reference bank.

The project website is live at [logitping.com](https://logitping.com), with an interactive output inspector, a methodology overview, and reference-bank details. Paste an existing model response into the browser playground to explore the protocol and results.

**Experimental 0.3.0.** Results describe behavioral similarity, not proof of model identity. `confidence` is a relative likelihood under statistical assumptions, not an empirically validated identity probability. Do not use a match as the sole basis for a security or billing decision.

The bundled bank contains **15 models**: 13 collected through OpenRouter on 2026-10-03, and `gemini-3.8-flash` and `gemini-4-argon` collected directly from Google AI Studio on 2026-10-21, each with 10 training and 5 threshold-calibration runs. It uses 512 English integer samples per run. Early stopping is disabled pending independent evaluation. See the [model list, collection settings, and evaluation status](docs/bank.md).

## Install

Use Node.js 22 or later and npm; CI checks Node.js 22 and 24 on Linux.

```sh
npm install -g logitping
lping --help
```

Both `logitping` and `lping` run the same CLI. To try the CLI without a global installation:

```sh
npx logitping --help
```

The [npm package](https://www.npmjs.com/package/logitping) includes ESM/CommonJS library exports, TypeScript declarations, and the reference documentation under `docs/`. See [Contributing](CONTRIBUTING.md) for development checks.

## Quickstart

This example probes `openai/gpt-6.1-sol` through OpenRouter using the Responses format and 8,192 output-token budget recorded in its reference fingerprint. You need an OpenRouter account with access to that route and an API key already exported as `OPENROUTER_API_KEY` through your shell or secret manager. `.env` files are not loaded automatically.

**Running this command sends one provider request and may incur charges, including reasoning tokens.** It does not refresh the bank or retry a failed probe. The CLI streams the response; the bank was collected without streaming, and transfer between those modes has not been independently evaluated. OpenRouter documents its [Responses endpoint and authentication](https://openrouter.ai/docs/api/reference/responses/overview).

```sh
LOGITPING_API_KEY="${OPENROUTER_API_KEY:?Export OPENROUTER_API_KEY first}" \
  lping \
  --provider openai \
  --endpoint https://openrouter.ai/api/v1 \
  --model openai/gpt-6.1-sol \
  --api-format responses \
  --max-tokens 8192 \
  --json \
  --no-interactive
```

The explicit key mapping is required: the probe CLI reads `LOGITPING_API_KEY`, not `OPENROUTER_API_KEY`. Keep real keys out of commands, screenshots, and issue reports. A supplied key is sent to the endpoint you choose; use an endpoint you trust. [More credential options](docs/cli.md) include `--key-file`.

A completed probe may return `INCONCLUSIVE` or `UNKNOWN_MODEL`. The following is an **excerpt from an offline replay** of a stored `gpt-6.1-sol` calibration run, not a promised live result. The full JSON also contains samples, scores, timing, and warnings.

```json
{
  "status": "INCONCLUSIVE",
  "model": null,
  "confidence": null,
  "reason": "Insufficient separation between enrolled models, or likelihood and OOD checks disagree",
  "evaluatedSamples": 512,
  "requestedSamples": 512,
  "earlyStopped": false
}
```

### Experimental: pooled short requests

`--pooled` sends 8 requests of 64 integers instead of one of 512. It costs about 0.72× as much, and it separates models with similar outputs better: on the 2026-10-11 collection, it named `gpt-6.1-sol` or `gpt-6-astra` correctly in 6 of 10 probes, where the default probe was inconclusive in every run. Between these two, its errors ran one way: with both enrolled, `gpt-6-astra` was sometimes named as `gpt-6.1-sol`, never the reverse. A single-model result is a `HEURISTIC_MATCH` (exit code 2), because an unenrolled model from the same vendor can produce it. **Each probe sends 8 provider requests.** See [bank status](docs/bank.md#experimental-pooled-bank).

    lping --endpoint https://openrouter.ai/api/v1 --model openai/gpt-6.1-sol --api-format responses --max-tokens 4096 --pooled --json

## Understand the result

| Status | Meaning | Exit code |
| --- | --- | --- |
| `IDENTIFIED` | One reference passed the nominal likelihood and distance checks; this is not identity attestation | `0` |
| `HEURISTIC_MATCH` | An explicitly enabled exploratory comparison found a reference candidate: across transports, or with the experimental `--pooled` bank; `confidence` is `null` | `2` |
| `INCONCLUSIVE` | Insufficient separation, disagreeing checks, or an incomplete response; with `--pooled`, `candidates` lists the models still consistent | `2` |
| `UNKNOWN_MODEL` | All enrolled distance regions rejected the observation; drift can also cause this | `2` |
| `UNCALIBRATED` | Samples were collected without a usable calibrated bank for this transport | `2` |
| `ERROR` | Invalid configuration, transport failure, or malformed output | `1` |

Exit `2` reports one of the four result statuses above; inspect `status` and `reason` rather than treating it as a transport failure. Cancellation exits with `130`; successful utility commands exit with `0`.

A local replay of 65 threshold-calibration runs produced 24 label matches and 41 inconclusive results. Removing each tested model from the bank produced four wrong matches in 65 trials, each with nominal confidence above 99.99%. **These are limited diagnostics, not independent accuracy estimates.** Read the [evaluation notes](docs/bank.md#evaluation-status) before interpreting scores.

## Supported connections

| Connection | Behavior with the bundled bank |
| --- | --- |
| OpenAI-compatible Chat Completions or Responses API | Compares samples with API references when protocol settings match |
| Anthropic Messages API | Compares samples with API references when protocol settings match |
| Locally authenticated Claude, Codex, or Antigravity (`agy`) CLI | Collects samples and returns `UNCALIBRATED`; identification needs a bank enrolled through that driver |
| CLI with `--allow-transport-mismatch` | Experimental comparison with API references; a match is reported as `HEURISTIC_MATCH` |

API compatibility permits a comparison; it does not establish accuracy across hosts, API formats, or streaming modes. The bundled bank requires English, 512 samples, and omitted temperature (`null` in the bank). Other settings require a matching bank. The [CLI reference](docs/cli.md) covers custom banks, token budgets, streaming, JSON errors, and credential handling.

Local CLI probes reuse your login and may incur provider usage or charges. Run them only with trusted binaries and backends. Codex and Antigravity may start a tool before the driver detects and terminates it; their temporary working directory and restricted settings are not a complete isolation boundary. Read the [transport limitations](docs/transports.md) first.

```sh
# Collection only with the bundled API bank; normally exits with code 2.
lping --driver claude --json
lping --driver codex --json
lping --driver antigravity --json
```

## Library

Install the library into your application:

```sh
npm install logitping
```

Then use the same reference settings:

```ts
import { HttpClient, fingerprint } from 'logitping';

const apiKey = process.env.LOGITPING_API_KEY;
if (!apiKey) throw new Error('Set LOGITPING_API_KEY to your OpenRouter API key');

const result = await fingerprint(new HttpClient({
  provider: 'openai',
  baseURL: 'https://openrouter.ai/api/v1',
  model: 'openai/gpt-6.1-sol',
  apiFormat: 'responses',
  apiKey,
}), {
  maxTokens: 8192,
  signal: AbortSignal.timeout(120_000),
});

console.log(result.status, result.model, result.confidence);
```

This makes the same kind of paid probe as the Quickstart. See the [library reference](docs/library.md) for custom banks, transports, cancellation, and error codes.

## Install from source

From an existing checkout or source archive, run:

```sh
npm ci
node dist/bin/logitping.js --help
```

`npm ci` builds through `prepare`. When following CLI examples from a source checkout, replace `lping` with `node dist/bin/logitping.js`. To install your local build instead of the registry version, run `npm pack` and `npm install -g ./logitping-0.3.0.tgz`.

## Documentation and contributing

- [Project website and browser playground](https://logitping.com)
- [Current bank and evaluation status](docs/bank.md)
- [CLI reference](docs/cli.md) and [library reference](docs/library.md)
- [Methodology and statistical assumptions](docs/methodology.md)
- [Bank enrollment, collection, and maintenance](docs/bank-maintenance.md)
- [Transport and platform limitations](docs/transports.md)
- [Contributing and development checks](CONTRIBUTING.md)
- [Security policy and private reporting](SECURITY.md)
- [Release notes](CHANGELOG.md)

Contributions are welcome, especially reproducible bug reports, independent evaluations, and improvements to protocol coverage. Follow the contribution guide to keep credentials and private data out of reports.

## License

[MIT](LICENSE). Builds include dependency license texts in `dist/THIRD_PARTY_NOTICES.md`.
