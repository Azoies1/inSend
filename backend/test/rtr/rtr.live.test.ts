/**
 * Live Payments Canada RTR sandbox tests. Excluded from `npm test`; run with
 * `npm run test:live` (needs RTR_CONSUMER_KEY/SECRET in the repo .env).
 * Synthetic data only, sandbox base URL enforced by loadRtrConfig.
 */
import { describe, expect, it } from 'vitest';
import { loadEnvFile } from '../../src/loadEnv';
import { cents } from '../../src/money';
import {
  RTRSimAdapter,
  RTR_SANDBOX_TRIGGERS as T,
} from '../../src/payments/adapters/rtr-sim/RTRSimAdapter';
import { loadRtrConfig } from '../../src/payments/adapters/rtr-sim/config';
import { InMemoryRtrStore } from '../../src/payments/adapters/rtr-sim/store';
import { fetchTransport, type HttpTransport } from '../../src/payments/adapters/rtr-sim/transport';
import { runAdapterContract } from '../contract/adapterContract';
import { payee, triggerPayee } from './helpers';

loadEnvFile();
const config = loadRtrConfig(process.env);

function liveAdapter(transport: HttpTransport = fetchTransport) {
  const store = new InMemoryRtrStore();
  return { adapter: new RTRSimAdapter({ config, transport, store }), store };
}

runAdapterContract({
  adapterName: 'RTRSimAdapter (live sandbox)',
  finalTimeoutMs: 30_000,
  async create() {
    const { adapter } = liveAdapter();
    return {
      provider: adapter,
      async scenario(outcome) {
        return {
          payee: outcome === 'SETTLED' ? payee() : triggerPayee(T.REJECTED_SETTLEMENT_ABORTED),
          amountCents: cents(185000),
        };
      },
      async badSignatureWebhook(paymentId, state) {
        return { rawBody: Buffer.from(JSON.stringify({ paymentId, state })), headers: {} };
      },
    };
  },
});

describe('RTRSimAdapter live: four outcomes', () => {
  async function pay(adapter: RTRSimAdapter, account = payee(), ref = 'RENT-LIVE-1') {
    const { payeeRef } = await adapter.createPayee(account);
    return adapter.sendPayment({
      payeeRef,
      amountCents: cents(185000),
      idempotencyKey: `live-${crypto.randomUUID()}`,
      remittanceReference: ref,
    });
  }

  it('SETTLED', async () => {
    const { adapter, store } = liveAdapter();
    const sent = await pay(adapter);
    expect(sent.state).toBe('SETTLED');
    expect((await store.getPayment(sent.paymentId))?.status).toEqual(sent);
  });

  it('REJECTED', async () => {
    const { adapter, store } = liveAdapter();
    const sent = await pay(adapter, triggerPayee(T.REJECTED_SETTLEMENT_ABORTED));
    expect(sent).toMatchObject({ state: 'REJECTED', reason: { providerCode: 'AB04' } });
    expect((await store.getPayment(sent.paymentId))?.status).toEqual(sent);
  });

  it('ERROR', async () => {
    const { adapter, store } = liveAdapter();
    const sent = await pay(adapter, triggerPayee(T.MESSAGE_ERROR_SCHEMA));
    expect(sent).toMatchObject({ state: 'ERROR', reason: { providerCode: 'FF02' } });
    expect((await store.getPayment(sent.paymentId))?.status).toEqual(sent);
  });

  it('PENDING after a real timeout, then settled by enquiry; exactly one pacs.008', async () => {
    let sends = 0;
    let enquiries = 0;
    let starve = true;
    // Abort the network calls almost immediately while `starve` is on.
    const transport: HttpTransport = (request) => {
      if (request.url.endsWith('/payments')) sends++;
      if (request.url.endsWith('/payments/status')) enquiries++;
      const isRail = /\/payments(\/status)?$/.test(request.url);
      return fetchTransport(starve && isRail ? { ...request, timeoutMs: 1 } : request);
    };
    const { adapter, store } = liveAdapter(transport);
    const sent = await pay(adapter);
    expect(sent.state).toBe('PENDING');
    expect((await store.getPayment(sent.paymentId))?.delivery).toBe('unconfirmed');

    starve = false;
    expect((await adapter.getStatus(sent.paymentId)).state).toBe('SETTLED');
    expect(sends).toBe(1);
    expect(enquiries).toBe(2);
  });
});
