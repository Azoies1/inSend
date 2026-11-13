#!/usr/bin/env node
// Starts or stops the local Postgres container with whichever engine is installed.
// Usage: node scripts/db.mjs up|down
//
// Order of preference: `docker compose`, `podman compose` (both read
// docker-compose.yml), then plain `podman run`/`docker run` with the same
// settings for machines that have an engine but no compose provider.
// Keep the settings below in sync with docker-compose.yml.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const CONTAINER = 'rtr-sandbox-postgres';
const VOLUME = 'rtr-sandbox-pgdata';
const IMAGE = 'postgres:16-alpine';
const action = process.argv[2];

if (action !== 'up' && action !== 'down') {
  console.error('Usage: node scripts/db.mjs up|down');
  process.exit(2);
}

function run(cmd, args, { quiet = false } = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: false,
  });
  return { ok: result.status === 0, stdout: result.stdout ?? '', error: result.error };
}

function works(cmd, args) {
  const result = run(cmd, args, { quiet: true });
  return result.ok && !result.error;
}

function pickEngine() {
  for (const engine of ['docker', 'podman']) {
    if (!works(engine, ['--version'])) continue;
    if (!works(engine, ['info'])) {
      const hint = engine === 'podman' ? ' Try: podman machine start' : ' Is Docker running?';
      console.error(`${engine} is installed but not responding.${hint}`);
      process.exit(1);
    }
    return { engine, compose: works(engine, ['compose', 'version']) };
  }
  console.error('Neither Docker nor Podman was found. Install one to run the local database.');
  process.exit(1);
}

function waitHealthy(engine) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (works(engine, ['exec', CONTAINER, 'pg_isready', '-U', 'rtr', '-d', 'rtr_sandbox'])) {
      return;
    }
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 1000)']);
  }
  console.error('Postgres did not become ready within 60 s.');
  process.exit(1);
}

const { engine, compose } = pickEngine();

if (compose) {
  const args = action === 'up' ? ['compose', 'up', '-d', '--wait'] : ['compose', 'down'];
  process.exit(run(engine, args).ok ? 0 : 1);
}

if (action === 'down') {
  run(engine, ['rm', '-f', CONTAINER], { quiet: true });
  console.log(`Stopped ${CONTAINER} (data kept in volume ${VOLUME}).`);
  process.exit(0);
}

const state = run(engine, ['inspect', '-f', '{{.State.Running}}', CONTAINER], { quiet: true });
if (state.ok && state.stdout.trim() === 'true') {
  console.log(`${CONTAINER} already running.`);
} else {
  if (state.ok) run(engine, ['rm', '-f', CONTAINER], { quiet: true });
  const password = process.env.POSTGRES_PASSWORD || 'rtr_local_dev';
  const started = run(engine, [
    'run',
    '-d',
    '--name',
    CONTAINER,
    '-e',
    'POSTGRES_USER=rtr',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    'POSTGRES_DB=rtr_sandbox',
    '-p',
    '127.0.0.1:5432:5432',
    '-v',
    `${VOLUME}:/var/lib/postgresql/data`,
    IMAGE,
  ]);
  if (!started.ok) process.exit(1);
}
waitHealthy(engine);
console.log(`Postgres ready on 127.0.0.1:5432 (${engine}).`);
