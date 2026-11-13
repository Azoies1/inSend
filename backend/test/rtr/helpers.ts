import {
  RTRSimAdapter,
  RTR_SANDBOX_TRIGGERS,
} from '../../src/payments/adapters/rtr-sim/RTRSimAdapter';
import type { RtrConfig } from '../../src/payments/adapters/rtr-sim/config';
import { InMemoryRtrStore } from '../../src/payments/adapters/rtr-sim/store';
import type { HttpTransport } from '../../src/payments/adapters/rtr-sim/transport';
import type { CreatePayeeInput } from '../../src/payments/provider';

export const TEST_CONFIG: RtrConfig = {
  baseUrl: 'https://api.payments.ca/rtr-sandbox',
  tokenUrl: 'https://api.payments.ca/accesstoken',
  consumerKey: 'test-key',
  consumerSecret: 'test-secret',
  participantId: '111',
  debtorName: 'Synthetic Platform Account',
  debtorAccount: '00000-0000000',
  requestTimeoutMs: 1000,
};

/** Synthetic payee at the sandbox's receiving participant (999). */
export function payee(
  accountNumber = '0000002',
  name = 'Synthetic Landlord One',
): CreatePayeeInput {
  return { name, account: { institutionNumber: '999', transitNumber: '00000', accountNumber } };
}

/** A payee whose payments carry a sandbox trigger as their end-to-end id. */
export const triggerPayee = (trigger: string) => payee(trigger, `Synthetic Trigger ${trigger}`);

export function buildAdapter(transport: HttpTransport, now?: () => Date) {
  const store = new InMemoryRtrStore();
  const adapter = new RTRSimAdapter({
    config: TEST_CONFIG,
    transport,
    store,
    sleep: async () => undefined,
    ...(now ? { now } : {}),
  });
  return { adapter, store };
}

export { RTR_SANDBOX_TRIGGERS };
