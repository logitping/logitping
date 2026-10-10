# Contributing to logitping

logitping is an experimental behavioral fingerprinting tool. Contributions should make its measurements reproducible, its transports reliable, and its claims easy to evaluate. A successful synthetic test or a high likelihood weight does not establish real-model identity accuracy.

Visit the [project website](https://logitping.com) for the browser playground and project overview, and the [README](README.md) for installation and usage documentation.

## Development setup

Use Node.js 22 or 24 and npm; [CI](.github/workflows/ci.yml) checks both versions on Linux. Its Node.js 24 job also builds and dry-runs the updater under Node.js permission restrictions, using synthetic credentials without provider requests; see [bank-maintenance CI notes](docs/bank-maintenance.md#github-actions). Source and CI links in this guide refer to a repository checkout; those files are not shipped in npm tarballs. From a local checkout:

```sh
npm ci
npm run check
npm run test:package
node dist/bin/logitping.js --help
```

`npm ci` installs the locked dependencies and runs the `prepare` build. `npm run check` runs TypeScript checks, the test suite, and a clean build. `npm run test:package` packs and installs the local tarball into a temporary prefix, then checks both CLI names, ESM/CommonJS exports, declarations, a local HTTP probe, interrupt cleanup, and bank creation.

The tests and package smoke test need no provider credentials, paid model requests, or installed Claude/Codex CLI. They use synthetic fixtures, loopback HTTP servers, temporary files, and fake subprocesses. Allow loopback listening, child processes, and temporary-directory access in a sandbox. Dependency installation may require registry access; the package smoke test installs its tarball with npm's offline mode.

Useful commands while iterating:

```sh
npm run typecheck
npm test -- tests/engine.test.ts
npm run test:watch
npm run build
```

Run the complete checks above before submitting code or packaging changes. For documentation-only changes, verify commands and links against the current source. Do not run `bank:update`, a live API probe, or a real CLI-driver probe as part of routine verification: they can use paid accounts or existing local authentication. Live collection requires a deliberate choice of credentials, endpoints, and request budget.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/cli.ts`, `src/index.ts` | CLI and public library entry points |
| `src/core/` | Probe pipeline, HTTP clients, wire formats, errors, and cancellation |
| `src/drivers/` | Claude and Codex subprocess adapters |
| `src/probes/` | Reproducible prompts and strict incremental integer parsing |
| `src/math/` | Statistical features, distances, nuisance projection, and sequential tests |
| `src/data/` | Bank validation, enrollment, updater, and the bundled reference bank |
| `src/util/` | Shared validation limits and file helpers |
| `config/` | Public bank-collection configuration without credentials |
| `tests/` | Synthetic unit and integration tests and fixtures |
| `scripts/` | Build, package checks, license notices, and updater entry point |

`dist/` and `build/` are generated. The maintainer bundle in `build/maintainer.js` is separate from the published library and CLI. The public bundles include their dependencies, so the package has no runtime dependencies. The build generates `dist/THIRD_PARTY_NOTICES.md` from source maps, which are not published. License texts for packages embedded inside dependencies live in `scripts/embedded-licenses`; the build fails when a bundled package's notice is missing. Retain these checks when changing packaging or dependencies.

## Issues and pull requests

Use the repository's [issue tracker](https://github.com/logitping/logitping/issues) for ordinary bugs and proposed changes once the repository is public. Report security vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

For a bug report, include:

- The package version or commit, Node.js version, operating system, and relevant CLI version.
- A minimal command or library example, expected behavior, and observed behavior.
- Relevant protocol settings: transport, API format, sample count, language, temperature, token budget, and reference-bank provenance.
- Sanitized error codes or output and, where possible, a synthetic fixture that reproduces the problem without a live service.

Remove API keys, authorization headers, private endpoint URLs, account/gateway identifiers, local paths that reveal private information, and personal configuration before posting. Inspect JSON and logs yourself; do not assume automatic error sanitization makes every artifact safe to share. Do not upload `.env` files, `*.local.json`, checkpoints, raw provider responses, or authentication files.

Keep pull requests focused. Explain the problem, resulting behavior, and relevant validation. For a behavior fix, add a regression test that fails for the original defect; prefer deterministic fixtures over live requests. Document public CLI/library behavior changes and update [CHANGELOG.md](CHANGELOG.md). If a check could not run, state which one and why. Larger changes to the statistical method or bank schema benefit from a proposal describing the assumptions and compatibility impact before implementation.

## Contributing reference-bank data

Read [the methodology](docs/methodology.md) and [bank-maintenance instructions](docs/bank-maintenance.md) before collecting or replacing fingerprints. Bank updates are manual; routine CI does not collect model responses. `npm run bank:check` validates the configuration and prints its request budget without provider requests, although configuration validation still requires credential values. A dry run does not establish model availability or predict actual cost.

A bank contribution should include enough evidence for another contributor to reproduce the fit and assess the labels:

- Collection dates, requested model routes and versions, provider, API format or CLI version, and the basis for trusting the reference identity. Distinguish a requested route from independently attested identity; record known routing, fallback, or hosting uncertainty.
- Exact probe protocol and settings, including template/version, language, sample count, temperature, checkpoints, output-token budget, and relevant driver configuration. Explain any difference from the endpoint being evaluated.
- Counts of accepted, failed, short, malformed, retried, and truncated runs where available, plus the collection and rejection policy. Report protocol failures as outcomes; do not quietly select favorable replies.
- A reviewed, shareable integer corpus or an accessible artifact, its digest, collection configuration with secrets removed, and the commands or script needed to reproduce the fitted bank. The updater writes Git-ignored `*.corpus-<sha256>.json` files; committing only a digest does not make the data accessible. Confirm that you may redistribute any contributed data and state its license.
- Independent evaluation results, if making accuracy, rejection, or early-stopping claims, including the evaluation protocol, denominators, unknown-model families, drift conditions, and limitations.

Keep these three data roles separate:

| Data split | Purpose |
| --- | --- |
| Training | Fit categorical probabilities, centroids, and variances. |
| Threshold calibration (`validation` in enrollment input) | Set distance envelopes using separate runs. These runs are part of fitting the classifier. |
| Final evaluation | Assess the frozen bank and decision procedure on new runs that were used for neither fitting nor threshold selection. |

The enrollment minimums of three training and two calibration runs per model are structural requirements, not evidence of adequate accuracy. Results on threshold-calibration samples are diagnostics, not independent test accuracy. Report correct matches, incorrect matches, inconclusive results, unknown-model rejections, and protocol failures separately. Include sample counts and uncertainty rather than interpreting nominal `confidence` as a measured probability of identity.

Generated and incrementally updated banks set `sequentialValidated: false`. Keep it false unless independent evaluation supports the complete stopping rule at every tested prefix, including false matches on unenrolled models and behavior under drift. A good full-length result alone does not validate optional early stopping. Preserve the evidence and evaluation procedure alongside any proposed change to this flag.

Do not commit credentials or private collection configuration. Keep checkpoints private; publish only the reviewed data needed for reproduction. A collection provenance label records how data was obtained and cannot itself prove which model served a request.

## Release review

The current experimental release is `0.1.0`. Before each new release:

1. Run `npm ci`, `npm run check`, and `npm run test:package` on supported Node.js versions, and review `npm audit` results.
2. Prepare the npm installation instructions, current bank description, limitations, version, release date, and [release notes](CHANGELOG.md) before the final pack. Check the private reporting channel described in [SECURITY.md](SECURITY.md), and keep its availability statement accurate.
3. Inspect `npm pack --dry-run` output and the generated third-party notices. Confirm that no credentials, private configuration, checkpoints, corpora awaiting review, or stale build output enter the package.
4. Confirm repository visibility and the intended npm package name, review the release contents, and perform the actual publication as a separate deliberate step.
5. After publication, verify the registry version, published tarball integrity, clean installation, and both executable names. Confirm that the published README matches the prepared release documentation; editing local files alone does not update the already published tarball.

These checks prepare a reviewable release; running them does not publish a package or create a GitHub release.
