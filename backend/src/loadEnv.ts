import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Loads the repo-root .env into process.env if it exists. Variables already set
 * in the real environment win, so CI and shells can override the file.
 */
export function loadEnvFile(): void {
  const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}
