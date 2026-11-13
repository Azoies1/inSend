import { z } from 'zod';

export const ADAPTER_NAMES = ['fake', 'rtr-sim', 'zum'] as const;
export type AdapterName = (typeof ADAPTER_NAMES)[number];

/** Matches docker-compose.yml. A local throwaway database holding synthetic data only. */
const LOCAL_DATABASE_URL = 'postgres://rtr:rtr_local_dev@127.0.0.1:5432/rtr_sandbox';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  DATABASE_URL: z.url().default(LOCAL_DATABASE_URL),
  PAYMENT_ADAPTER: z.enum(ADAPTER_NAMES).default('fake'),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  databaseUrl: string;
  paymentAdapter: AdapterName;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Builds config from environment variables. Empty values count as unset, so a
 * straight copy of .env.example yields the sandbox defaults.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const present: Record<string, string> = {};
  for (const key of Object.keys(schema.shape)) {
    const value = env[key]?.trim();
    if (value) present[key] = value;
  }

  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment configuration: ${problems}`);
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    host: parsed.data.HOST,
    databaseUrl: parsed.data.DATABASE_URL,
    paymentAdapter: parsed.data.PAYMENT_ADAPTER,
  };
}
