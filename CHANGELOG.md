# Changelog

## 0.1.0 — 2026-10-08

Initial experimental release on [npm](https://www.npmjs.com/package/logitping/v/0.1.0). Install the CLI with `npm install -g logitping`, or add the library with `npm install logitping`. See the [README](README.md) for the Quickstart.

### Added

- A Node.js/TypeScript CLI (`logitping`, also available as `lping`) and library for collecting and comparing LLM behavioral fingerprints.
- HTTP transports for OpenAI-compatible Chat Completions, OpenAI Responses, and Anthropic Messages, plus drivers that reuse local Claude and Codex CLI authentication.
- Strict incremental parsing of integer probes, ordered distribution features, sequential likelihood comparisons, and calibrated distance envelopes for rejecting observations outside the reference bank. An optional tokenizer challenge records diagnostic text without using it for classification.
- Protocol checks for transport, language, sample budget, and temperature. An explicit cross-transport comparison mode reports heuristic results without identity confidence.
- Offline bank enrollment and a resumable Cloudflare AI Gateway/OpenRouter bank updater, with separate training and threshold-calibration runs, collection provenance, request budgets, and a corpus SHA-256 digest.
- ESM and CommonJS library bundles, TypeScript declarations, bundled third-party license notices, and package installation smoke checks.
- Credential scoping and error redaction, HTTPS by default for remote endpoints, redirect rejection, probe cancellation, and restrictions on local CLI tools. See the [security policy](SECURITY.md) for reporting and trust boundaries.

### Development dependency security

- Updated the locked `source-map-js` development dependency to `1.2.2`, which addresses [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q). This package is used by build/test tooling and is not bundled into the published runtime.

### Bundled reference bank

The bank was collected through OpenRouter on **2026-10-03**. It contains 13 requested model identities, with 10 training runs and 5 threshold-calibration runs per model. Each accepted run contributes the first 512 integers under the English `integer-v1` protocol, with `temperature: null` and transport `api`. The requests used an output-token budget of 8,192.

The bank has `sequentialValidated: false`, so early stopping is disabled. Provider catalog labels are collection metadata, not independent model attestations. The corpus digest records provenance; the raw corpus is not currently distributed in the repository. See [bank documentation](docs/bank.md) for configuration, reproducibility, and evaluation limits.

### Experimental limits and compatibility

- Model identity accuracy has not been established on an independent final evaluation set. `confidence` is a relative likelihood weight under the bank's assumptions, not a calibrated probability that the claimed identity is correct. High weights can accompany incorrect matches; inconclusive and unknown-model results are expected.
- The bundled bank provides API references; transfer across serving hosts, streaming modes, and API formats has not been independently evaluated. Claude and Codex CLI probes collect samples and return `UNCALIBRATED` by default; identification requires a bank measured with the matching CLI transport and protocol. Opting into a transport mismatch provides only an exploratory comparison.
- Codex tool restrictions are not a security sandbox. Aborting on a tool event can race the action itself; use only backends you trust with the remaining local access. See [transport documentation](docs/transports.md).
- The runtime requires **Node.js 22 or later**. CI covers Node.js 22 and 24 on Linux. Windows is not covered by CI, and local CLI behavior depends on the installed CLI version and configuration.
- The CLI, library API, bank format, and statistical behavior may change during the experimental 0.x series. Provider requests may incur charges.

For development and fingerprint contribution requirements, see [CONTRIBUTING.md](CONTRIBUTING.md).
