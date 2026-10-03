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
console.log(result.status, result.model, result.confidence);
```

Pass `maxTokens` to `fingerprint()` to raise the integer request's output budget; see [`--max-tokens`](cli.md).

Errors that callers may want to handle are `LogitpingError` instances with a stable `code`: `HTTP_STATUS` (with the response `status`), `NETWORK` (a DNS, connection, or TLS failure, or a refused redirect; the underlying error is its `cause`), `PROTOCOL_MISMATCH`, `INVALID_BANK` (a malformed bank or bank file, from `validateBank()`, `loadBank()`, or `fingerprint()`), `MALFORMED_OUTPUT` (an `IntegerOutputError` with the invalid `position`), `PROVIDER_RESPONSE`, `TRUNCATED`, `CLI_NOT_FOUND`, and `CLI_FAILED`. A deadline rejects with a `DOMException` named `TimeoutError`, as `AbortSignal.timeout()` does; cancellation rejects with the signal's reason. Invalid arguments throw `TypeError` or `RangeError`, and file-system errors keep Node's `code`, such as `ENOENT`. Messages are diagnostic text and may change between versions.

## Custom transports

`ClaudeDriver` and `CodexDriver` implement the same `ProbeTransport` interface. Their `env` option sets the CLI's complete environment; by default the CLI inherits yours without `LOGITPING_API_KEY`. Their `binary` option names the executable to run and must be trusted. Custom transports can implement `stream(request): AsyncIterable<string>`; emit only assistant response text and honor `request.signal`. The engine can stop waiting for a pending `next()` when the deadline or cancellation fires, but only the transport can release its own sockets or processes. The current implementation awaits iterator cleanup after stopping consumption: `return()` and generator `finally` blocks must finish promptly. A custom transport that stalls during cleanup can keep `fingerprint()` pending beyond its configured deadline.
