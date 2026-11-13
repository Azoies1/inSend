import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { loadConfig } from '../config';
import { loadEnvFile } from '../loadEnv';

/** Applies all pending SQL migrations in backend/migrations. Usage: npm run migrate [up|down] */
loadEnvFile();
const config = loadConfig();
const direction = process.argv[2] === 'down' ? 'down' : 'up';

const applied = await runner({
  databaseUrl: config.databaseUrl,
  dir: fileURLToPath(new URL('../../migrations', import.meta.url)),
  migrationsTable: 'schema_migrations',
  direction,
  count: direction === 'down' ? 1 : undefined,
});

console.log(
  applied.length === 0
    ? 'Migrations: nothing to do.'
    : `Migrations ${direction}: ${applied.map((migration) => migration.name).join(', ')}`,
);
