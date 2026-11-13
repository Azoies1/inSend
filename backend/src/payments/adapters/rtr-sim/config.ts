import { z } from 'zod';
import { ConfigError } from '../../../config';

/**
 * RTR sandbox settings. Everything here is provider-specific and stays inside
 * this adapter. Defaults are the Payments Canada RTR sandbox values from
 * https://github.com/paymentscanada/api-toolkit (develop branch,
 * swagger-oas/RTR-Sandbox and postman-collection/RTR-Sandbox).
 */
export interface RtrConfig {
  baseUrl: string;
  tokenUrl: string;
  consumerKey: string;
  consumerSecret: string;
  /** Clearing system member id we send as (instructing agent / debtor agent). Sandbox: 111. */
  participantId: string;
  /** The synthetic account the platform pays from (pacs.008 debtor, mandatory in the schema). */
  debtorName: string;
  debtorAccount: string;
  requestTimeoutMs: number;
}

const schema = z.object({
  RTR_BASE_URL: z.url().default('https://api.payments.ca/rtr-sandbox'),
  RTR_TOKEN_URL: z.url().default('https://api.payments.ca/accesstoken'),
  RTR_CONSUMER_KEY: z.string().min(1, 'is required for PAYMENT_ADAPTER=rtr-sim'),
  RTR_CONSUMER_SECRET: z.string().min(1, 'is required for PAYMENT_ADAPTER=rtr-sim'),
  RTR_PARTICIPANT_ID: z
    .string()
    .regex(/^\d{3}$/)
    .default('111'),
  RTR_DEBTOR_NAME: z.string().min(1).max(140).default('Synthetic Platform Account'),
  RTR_DEBTOR_ACCOUNT: z.string().min(1).max(34).default('00000-0000000'),
  RTR_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).default(15000),
});

export function loadRtrConfig(env: Record<string, string | undefined>): RtrConfig {
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
    throw new ConfigError(`Invalid RTR sandbox configuration: ${problems}`);
  }
  const d = parsed.data;
  assertSandboxUrl(d.RTR_BASE_URL);
  return {
    baseUrl: d.RTR_BASE_URL.replace(/\/+$/, ''),
    tokenUrl: d.RTR_TOKEN_URL,
    consumerKey: d.RTR_CONSUMER_KEY,
    consumerSecret: d.RTR_CONSUMER_SECRET,
    participantId: d.RTR_PARTICIPANT_ID,
    debtorName: d.RTR_DEBTOR_NAME,
    debtorAccount: d.RTR_DEBTOR_ACCOUNT,
    requestTimeoutMs: d.RTR_REQUEST_TIMEOUT_MS,
  };
}

/**
 * Guardrail: this build never calls production. api.payments.ca serves both
 * sandbox and production APIs, so the payment base URL must be HTTPS and point
 * at a sandbox path.
 */
export function assertSandboxUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !/sandbox/i.test(parsed.pathname)) {
    throw new ConfigError(
      `RTR_BASE_URL must be an https sandbox endpoint (path containing "sandbox"), got ${url}`,
    );
  }
}
