import { Agent, fetch as undiciFetch } from 'undici';

/** A fetch for collection requests, and the connection pool that serves it. */
export interface CollectionFetch {
  fetch: typeof globalThis.fetch;
  /** Close the pool once the collection is done. */
  close(): Promise<void>;
}

/**
 * Node's built-in fetch stops waiting for response headers after 300 s, and a non-streaming
 * reply sends none until generation ends, so a slow reasoning model would fail before the
 * configured deadline. Collection requests get their own pool whose header and body limits
 * follow `timeoutMs`. Maintainer tooling only: the published library keeps the built-in fetch.
 */
export function collectionFetch(timeoutMs: number): CollectionFetch {
  const dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  const fetch = (url: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
    undiciFetch(url, { ...init, dispatcher });
  return { fetch: fetch as unknown as typeof globalThis.fetch, close: () => dispatcher.close() };
}
