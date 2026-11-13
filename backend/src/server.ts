import { buildApp } from './app';
import { loadConfig } from './config';
import { createPool, pingDb } from './db/pool';
import { loadEnvFile } from './loadEnv';
import { createProvider } from './payments/registry';

loadEnvFile();
const config = loadConfig();
const pool = createPool(config.databaseUrl);
// A dropped idle connection must not crash the process; /health reports it.
pool.on('error', (error) => console.error('Postgres pool error:', error.message));

const app = buildApp({
  provider: createProvider(config.paymentAdapter),
  pingDb: () => pingDb(pool),
  logger: config.nodeEnv !== 'test',
});

async function shutdown(): Promise<void> {
  await app.close();
  await pool.end();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown().then(() => process.exit(0)));
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  await pool.end();
  process.exit(1);
}
