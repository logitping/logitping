import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpClient } from '../src/core/client.js';
import { fingerprint } from '../src/core/engine.js';
import { syntheticBank } from './fixtures.js';

describe('native HTTP streaming integration', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });

  it('stops a real streaming socket when the sequential and OOD checks pass', async () => {
    let sent = 0;
    let sawRequest: Record<string, unknown> = {};
    let responseClosed!: () => void;
    const closed = new Promise<void>((resolve) => { responseClosed = resolve; });
    server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      sawRequest = JSON.parse(body) as Record<string, unknown>;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const timer = setInterval(() => {
        sent++;
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '17 ' } }] })}\n\n`);
        if (sent >= 128) {
          clearInterval(timer);
          response.end('data: [DONE]\n\n');
        }
      }, 2);
      response.on('close', () => { clearInterval(timer); responseClosed(); });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const client = new HttpClient({ provider: 'openai', baseURL: `http://127.0.0.1:${address.port}`, model: 'test-reference' });
    const result = await fingerprint(client, { bank: syntheticBank(), tokenizerProbe: false });
    await closed;
    expect(result.status).toBe('IDENTIFIED');
    expect(result.samples).toHaveLength(64);
    expect(sent).toBeLessThan(128);
    expect(sawRequest).toMatchObject({ model: 'test-reference', stream: true });
  });

  async function listen(target: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      target.once('error', reject);
      target.listen(0, '127.0.0.1', resolve);
    });
    const address = target.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    return address.port;
  }

  it('reports a real redirect as NETWORK without following it', async () => {
    let requests = 0;
    server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(307, { location: '/v1/chat/completions/' });
      response.end();
    });
    const port = await listen(server);
    const client = new HttpClient({ provider: 'openai', baseURL: `http://127.0.0.1:${port}`, model: 'test', apiKey: 'test-secret' });
    await expect(client.complete({ prompt: 'test', maxTokens: 10 })).rejects.toMatchObject({ code: 'NETWORK', message: expect.stringContaining('the endpoint redirected') });
    expect(requests).toBe(1);
  });

  it('reports a real refused connection as NETWORK with its system code', async () => {
    // Reserve a free port, then release it so that connecting is refused.
    const reserved = createServer();
    const port = await listen(reserved);
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    const client = new HttpClient({ provider: 'openai', baseURL: `http://127.0.0.1:${port}`, model: 'test' });
    await expect(client.complete({ prompt: 'test', maxTokens: 10 })).rejects.toMatchObject({ code: 'NETWORK', message: `Could not reach 127.0.0.1:${port}: ECONNREFUSED` });
  });
});
