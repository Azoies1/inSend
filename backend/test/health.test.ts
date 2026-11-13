import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { FakeAdapter } from '../src/payments/adapters/fake/FakeAdapter';

describe('GET /health', () => {
  it('responds ok with the active adapter when the database answers', async () => {
    const app = buildApp({ provider: new FakeAdapter(), pingDb: async () => undefined });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', adapter: 'fake', db: 'up' });
  });

  it('responds 503 when the database is unreachable', async () => {
    const app = buildApp({
      provider: new FakeAdapter(),
      pingDb: async () => {
        throw new Error('connection refused');
      },
    });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'degraded', adapter: 'fake', db: 'down' });
  });
});
