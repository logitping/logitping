# Pooled-probe research scripts

Offline scripts behind `specs/2026-10-11-pooled-probe-design.md`. They read local corpora only and make no provider requests. Build first (`npm run build`), because they import `../../dist/index.js`.

| Script | Purpose |
|---|---|
| `prototype.mjs` | The prototype frozen before the 2026-10-11 collection: conformal prediction sets C1–C5 over seven feature groups. |
| `prototype-eval.mjs` | `prototype.mjs` plus harness options: `KS` (requests per unit), `DROP_LOOPS`, and the unenrolled (leave-one-model-out) refit. |
| `gate-test.mjs` | Exploratory follow-up: C1 and C4 with each model's per-response OOD envelope in front of the set, against the current engine pooled over the same requests. |
| `check-pooled.mjs` | Checks the production implementation against the prototype; see Task 10 of the plan. |

`prototype.mjs` was frozen with SHA-256 `2964649026827d4774b2331b8a70c55b85a9eb3b2e4e7552166acdb40fffed24`. The only change since is its import line: an absolute local path became `'../../dist/index.js'`. Its SHA-256 is now `e28a621b8553f222821f5d159af0ad267ff75816d0a30afc5e9b60193b33ebfd`.

`prototype.mjs` and `prototype-eval.mjs` keep the original loop rule (any period up to 128). On 64-integer runs it wrongly flags a run whose first and last values match: one `gpt-6.1-sol` run with `DROP_LOOPS=1`. `gate-test.mjs` and the bank updater cap the period at a quarter of the run.

The corpora are git-ignored and stay at the repository root:

- `research-512.local.json.corpus-73559ea6….json`: 13 models × 40 runs × 512 integers.
- `research-64.local.json.corpus-4d34afe7….json`: 13 models × 40 runs × 64 integers.

Both were collected through OpenRouter on 2026-10-11.

Example: `KS=4,8 node scripts/research/gate-test.mjs research-64.local.json.corpus-4d34afe7497e9d0d83238136885022a808a5c0e6ecfcfc32b7ed5689131f0bbf.json`

## Implementation check

`check-pooled.mjs` compares the production `createPooledBank` and engine with the prototype on `research-64.local.json.corpus-4d34afe7….json`:

- **Arithmetic:** largest relative difference 0, against a limit of 1e-9.
- **Leave-group-out at 8 requests**, gate test C4 gated in parentheses:
  - correct single model 45/65 (45/65);
  - wrong single model 1/65 (1/65);
  - unenrolled model named 9/65 (9/65).

Exact equality is not guaranteed, because the bootstrap draws in a different order; on this corpus the results coincide. The check runs in about 15 s.
