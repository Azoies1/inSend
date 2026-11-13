import Fastify, { type FastifyInstance } from 'fastify';
import type { PaymentProvider } from './payments/provider';

export interface AppDeps {
  provider: PaymentProvider;
  /** Resolves if the database answers, rejects otherwise. */
  pingDb: () => Promise<void>;
  logger?: boolean;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });

  app.get('/health', async (_request, reply) => {
    let db: 'up' | 'down' = 'up';
    try {
      await deps.pingDb();
    } catch {
      db = 'down';
    }
    return reply.code(db === 'up' ? 200 : 503).send({
      status: db === 'up' ? 'ok' : 'degraded',
      adapter: deps.provider.name,
      db,
    });
  });

  return app;
}
