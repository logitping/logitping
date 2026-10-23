# Changelog

## Unreleased

### Fixed

- An Antigravity probe that `agy`'s backend refused no longer fails as `Antigravity attempted a tool action during the probe; aborted`. `agy` ends a refused turn with an `error_message` step, which the driver mistook for a tool. The probe now fails as `Antigravity reported an unsuccessful probe` and names the backend's status and code, such as `FAILED_PRECONDITION (code 400)`, but never its message text. For a request refused because of the user's location, it adds a fixed note saying so. A turn with an `error_message` step is never accepted.

## 0.3.0 — 2026-10-23

Adds an Antigravity CLI driver and direct Google AI Studio collection, and enrolls two Gemini models in the bundled bank, which now has 15. The 13 earlier references and the pooled bank are unchanged.

### Added

- Antigravity CLI driver (`--driver antigravity`; library: `AntigravityDriver`), which runs `agy` headless over stream-json with the prompt on stdin. `agy` cannot turn its tools off, so the driver refuses to sample unless `agy` starts in `request-review` permission mode, and it terminates `agy` at the first step that is not a response. Read-only tools can still start before that, so every Antigravity result carries the same tool warning as Codex. Banks accept `protocol.transport: "antigravity"`. See the [transport limitations](docs/transports.md).
- The bank updater can request models directly from Google AI Studio (`"provider": "google"`, key in `GEMINI_API_KEY`) through Google's OpenAI-compatible Chat Completions endpoint, with no relay in between. Provenance records `cache=none` for these models, since there is no response cache to bypass.
- `CliDriver` subclasses can override `executable()`, the default command and the name used in messages, and `stdin()`, the text written for a prompt.

### Fixed

- The bank updater no longer fails requests that take longer than 300 s. A non-streaming reply sends no headers until generation ends, and Node's built-in fetch stopped waiting for them after 300 s, short of the 600 s `timeoutMs` maximum. Updater requests now go through their own connection pool, whose header and body limits follow `timeoutMs`. It uses undici, bundled into the maintainer tooling only, so the updater needs Node.js 22.19 or later; the published library is unchanged.

### Development dependency security

- Updated the `vite` development dependency to `6.4.4` and `vitest` to `4.1.12`. They address advisories in vite and its bundled `launch-editor` ([GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm), [GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw), [GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv), [GHSA-rq7h-c2jc-7f22](https://github.com/advisories/GHSA-rq7h-c2jc-7f22), [GHSA-9jrq-w75r-8gcw](https://github.com/advisories/GHSA-9jrq-w75r-8gcw)) and in `@vitest/mocker` ([GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8), [GHSA-xp26-3454-mjgp](https://github.com/advisories/GHSA-xp26-3454-mjgp)). These packages are used by test tooling and are not bundled into the published runtime.

### Bundled reference bank

- Enrolls `gemini-3.8-flash` (family `gemini`), collected directly from Google AI Studio on **2026-10-21**: 10 training and 5 threshold-calibration runs of 512 English integers, with an 8,192-token output budget. The 13 earlier references are unchanged, and replaying their stored runs gives the same results as before. The pooled bank does not include Gemini. See [bank documentation](docs/bank.md).
- Enrolls `gemini-4-argon` (family `gemini`), also collected directly from Google AI Studio on **2026-10-21**, with a 32,768-token output budget, its maximum. About 4 in 10 of its replies were cut off at that limit and sent again, so expect many Argon probes to end `INCONCLUSIVE` with a short reply; probe it with `--max-tokens 32768`. At 512 integers the two Gemini models are hard to tell apart: replays of their stored runs are `INCONCLUSIVE`, never a wrong match, and adding Argon turned the two `gemini-3.8-flash` matches of the 14-model bank into `INCONCLUSIVE`.

### Documentation

- The bank notes show where pooled-probe errors concentrate: with both enrolled, `gpt-6-astra` was sometimes named as `gpt-6.1-sol`, never the reverse.
- The CLI reference shows how to probe Google's OpenAI-compatible Gemini API, which needs its full Chat Completions URL.

## 0.2.1 — 2026-10-12

Documentation-only release: no code, bank, or behavior changes from 0.2.0.

### Documentation

- The README and methodology no longer describe a lineage between `gpt-6.1-sol` and `gpt-6-astra`, which no evidence supports. Both models are now described only by their measured outputs.
- The README, methodology, and bank notes say "similar models from the same vendor" where they said "close relatives", which is all the measurements show.

## 0.2.0 — 2026-10-12

### Added

- Experimental pooled probe (`--pooled`; library: `pooledBank()`):
  - Each probe sends 8 requests of 64 integers and scores them together as a calibrated prediction set over seven feature groups, with each model's distance envelope applied to every reply.
  - A single-model set returns `HEURISTIC_MATCH`, several return `INCONCLUSIVE` with `candidates`, and none returns `UNKNOWN_MODEL`.
  - A short reply, or one identical to an earlier reply, ends the probe as `INCONCLUSIVE`.
  - The bundled pooled bank covers the 13 reference models, collected on 2026-10-11 (25 training and 15 held-out runs each).
  - See the README for its measured rates and limits.
- Pooled banks use bank schema version 2, which logitping 0.1.0 rejects:
  - `createPooledBank()` builds one from enrollment runs;
  - the bank updater fits one when its configuration sets `"scoring": "pooled-sets-v1"` and `"requestsPerProbe"`;
  - `npm run bank:pooled` adds pooled scoring to a collected bank from its archived corpus.
  - Incremental updates are refused for pooled banks.
- `ProbeResult.candidates` and `ProbeResult.requests`, and the pooled `fit`, `margin` and cutoff fields in `scores`.
- In a pooled probe, `onText` receives the request number, from 1, as a third argument.

### Changed

- `--stream` starts a new line when the stage changes from the tokenizer reply to the integers, and at each request of a pooled probe.
- The bank updater rejects and retries a reply whose integers loop: at least 90% of positions repeat the integer one period earlier, for a period of at most 128 integers and a quarter of the run. Such a reply counts as invalid in provenance and shares the `maxProbeRetries` allowance. A looping run in the bundled bank's corpus (`gpt-5.6-luna` training run 2) cycles through 32 values; it remains in the bundled bank until the next full update.

### Fixed

- Interactive mode no longer fails with `Cannot read properties of undefined (reading 'trim')` when the bank path is left blank; it uses the bundled bank, as the prompt describes.
- `--json` output writes C1 control and bidirectional formatting characters in model text, such as a tokenizer response, as `\uXXXX` escapes, so an endpoint cannot control or reorder the terminal display. Parsing the JSON restores the original text.
- The third-party notice generator now recognizes bundled packages in Windows paths, and the build fails instead of publishing an empty notice list when it recognizes none.

### Documentation

- Announced the published project website at [logitping.com](https://logitping.com), including its browser playground, methodology overview, and reference-bank details, in the README and contributor guide.
- Updated the npm package homepage to point to the project website.

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
