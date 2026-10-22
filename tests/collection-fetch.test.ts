import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { collectionFetch } from '../src/data/collection_fetch.js';

describe('collectionFetch', () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((done) => server?.close(done) ?? done(undefined));
    server = undefined;
  });

  /** A local server that holds back the response headers, or the body after them, for `ms`. */
  async function slow(stage: 'headers' | 'body', ms: number): Promise<string> {
    server = createServer((_request, response) => {
      if (stage === 'headers') {
        setTimeout(() => response.end('done'), ms);
      } else {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('partial ');
        setTimeout(() => response.end('done'), ms);
      }
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  }

  it('waits for late response headers within its deadline', async () => {
    const url = await slow('headers', 600);
    const transport = collectionFetch(5_000);
    try {
      const response = await transport.fetch(url);
      expect(await response.text()).toBe('done');
    } finally { await transport.close(); }
  });

  // Node's built-in fetch waits 300 s for headers; the collection deadline replaces that limit.
  it('applies its deadline, not the built-in fetch limit, to response headers', async () => {
    const url = await slow('headers', 3_000);
    const transport = collectionFetch(300);
    try {
      await expect(transport.fetch(url)).rejects.toMatchObject({ cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });
    } finally { await transport.close(); }
  });

  it('applies its deadline to a stalled response body', async () => {
    const url = await slow('body', 3_000);
    const transport = collectionFetch(300);
    try {
      const response = await transport.fetch(url);
      await expect(response.text()).rejects.toMatchObject({ cause: { code: 'UND_ERR_BODY_TIMEOUT' } });
    } finally { await transport.close(); }
  });
});
