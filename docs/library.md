# Library reference

[Back to README](../README.md) · [CLI reference](cli.md)

Install the library with `npm install logitping`; see [installation](../README.md#install).

```ts
import { HttpClient, fingerprint, loadBank } from 'logitping';

const apiKey = process.env.LOGITPING_API_KEY;
const transport = new HttpClient({
  provider: 'openai',
  baseURL: 'https://api.example.com/v1',
  ...(apiKey ? { apiKey } : {}),
  model: 'claimed-model',
});

const result = await fingerprint(transport, {
  bank: await loadBank('./bank.local.json'),
  signal: AbortSignal.timeout(120_000),
  onProgress: (count) => console.error(`Collected ${count} integers`),
});
console.log(result.status, result.model, result.candidates);
```

Pass `maxTokens` to `fingerprint()` to raise each integer request's output budget; see [`--max-tokens`](cli.md). `collectionSettingsFor(bank, model)` returns `{ id, collection }` for an enrolled model, or `undefined`. `collection` holds what the model was collected with: `maxTokens`, `apiFormat`, `tokenLimitField`, the requested `route` and the collection `provider`. The library does not apply them. Pass `collection.maxTokens` to `fingerprint()`. For `HttpClient`, an `apiFormat` of `messages` means `provider: 'anthropic'`; otherwise use `provider: 'openai'` with that `apiFormat`, and pass `tokenLimitField`.

Pass `claim` to check a claimed model, as in `fingerprint(transport, { claim: 'openai/gpt-6.2-sol' })`; its last `/` segment names a bank model, ignoring case. The result then carries `claim`, a `ClaimCheck`: `requested`, the enrolled `model` or `null`, a `verdict`, a `reason`, and `rates`. The verdict is `CONSISTENT` when the model is among `candidates`, `INCONSISTENT` when it is not, `NOT_ENROLLED` when the bank enrolls no such model, and `NOT_CHECKED` when no candidates were computed or the model is uncalibrated. `rates` holds the claim's acceptance counts on stored runs, each with the bounds of its 95% Wilson score interval as fractions: `own` (with `source` `independent` or `tuning`), `enrolled`, `outside`, and `mostAccepted`. They are attached only to `CONSISTENT` and `INCONSISTENT` verdicts when `fingerprint()` is called without `bank`, so that it scores with the bundled default bank, and never to cross-transport comparisons. A bank you pass, even one `defaultBank()` returned, gets `rates: null`, because it may have been changed. The rates are not a probability that the endpoint serves the claimed model.

Errors that callers may want to handle are `LogitpingError` instances with a stable `code`: `HTTP_STATUS` (with the response `status`), `NETWORK` (a DNS, connection, or TLS failure, or a refused redirect; the underlying error is its `cause`), `PROTOCOL_MISMATCH`, `INVALID_BANK` (a malformed bank or bank file, from `validateBank()`, `loadBank()`, or `fingerprint()`, or a malformed bundled claim-rate file), `MALFORMED_OUTPUT` (an `IntegerOutputError` with the invalid `position`), `PROVIDER_RESPONSE`, `TRUNCATED`, `CLI_NOT_FOUND`, and `CLI_FAILED`. A deadline rejects with a `DOMException` named `TimeoutError`, as `AbortSignal.timeout()` does; cancellation rejects with the signal's reason. Invalid arguments throw `TypeError` or `RangeError`, and file-system errors keep Node's `code`, such as `ENOENT`. Messages are diagnostic text and may change between versions.

## Experimental pooled probe

`pooledBank()` resolves to the bundled pooled bank: 8 requests of 64 integers, scored as a prediction set (see [methodology](methodology.md#experimental-pooled-probe-pooled-sets-v1)). Pass it as `bank`: `fingerprint(transport, { bank: await pooledBank(), maxTokens: 4096 })`. A single-model set returns `HEURISTIC_MATCH`, with the candidate in `model`. Two or more return `INCONCLUSIVE`, and none returns `UNKNOWN_MODEL`. `candidates` lists the set and `requests` the requests sent; `onText` receives the request number, from 1, as its third argument. An unenrolled model from the same vendor as an enrolled one can produce a single-model set. One deadline, `timeoutMs` (120,000 ms by default) or `signal`, covers all requests together. `createPooledBank(input)` builds a pooled bank from the same enrollment input as `createFingerprintBank`, plus `requestsPerProbe` and an optional bootstrap `seed`, an unsigned 32-bit integer (20261011 by default). The bank records the seed, so the same runs and seed give the same cutoffs.

## Custom transports

`ClaudeDriver`, `CodexDriver`, and `AntigravityDriver` implement the same `ProbeTransport` interface; `AntigravityDriver` runs `agy` under the transport name `antigravity`. Their `env` option sets the CLI's complete environment. By default the CLI receives an allowlist of yours, described in the [transport limitations](transports.md), and never `LOGITPING_API_KEY`; `passEnv` adds variable names or prefixes such as `'AWS_*'`, and cannot be combined with `env`. A `CliDriver` subclass receives only the shared variables unless it overrides the protected `environmentPrefixes()` with its CLI's prefixes or is given `passEnv`; its protected `environmentExclusions()` drops names those prefixes would otherwise pass. Their `binary` option names the executable to run and must be trusted. Custom transports can implement `stream(request): AsyncIterable<string>`; emit only assistant response text and honor `request.signal`. A transport that sets `reportsUsage: true` calls `request.onUsage` with the token counts its provider reports; the result then carries them in `usage`, and the engine reads each response for up to 5 s after its last needed integer before aborting it. The engine can stop waiting for a pending `next()` when the deadline or cancellation fires, but only the transport can release its own sockets or processes. The current implementation awaits iterator cleanup after stopping consumption: `return()` and generator `finally` blocks must finish promptly. A custom transport that stalls during cleanup can keep `fingerprint()` pending beyond its configured deadline.
