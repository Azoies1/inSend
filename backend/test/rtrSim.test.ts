import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config';
import { cents, type Cents } from '../src/money';
import { TokenProvider } from '../src/payments/adapters/rtr-sim/auth';
import { loadRtrConfig } from '../src/payments/adapters/rtr-sim/config';
import { buildCreditTransfer, centsToDecimalLiteral } from '../src/payments/adapters/rtr-sim/iso';
import { TransportTimeoutError, fetchTransport } from '../src/payments/adapters/rtr-sim/transport';
import type { PaymentProvider } from '../src/payments/provider';
import { replayTransport, type ReplayCall } from './rtr/fixtures';
import { RTR_SANDBOX_TRIGGERS as T, buildAdapter, payee, triggerPayee } from './rtr/helpers';

async function pay(provider: PaymentProvider, account = payee(), key = 'key-1') {
  const { payeeRef } = await provider.createPayee(account);
  const input = {
    payeeRef,
    amountCents: cents(185000),
    idempotencyKey: key,
    remittanceReference: 'RENT-2026-12-UNIT1',
  };
  return { input, sent: await provider.sendPayment(input) };
}

const timeout = (call: ReplayCall) => {
  throw new TransportTimeoutError(call.request.url, call.request.timeoutMs);
};

describe('RTRSimAdapter: the four outcomes, with stored state', () => {
  it('SETTLED: pacs.002 ACSP', async () => {
    const { adapter, store } = buildAdapter(replayTransport().transport);
    const { sent } = await pay(adapter);
    expect(sent).toEqual({ paymentId: sent.paymentId, state: 'SETTLED' });
    const stored = await store.getPayment(sent.paymentId);
    expect(stored).toMatchObject({ status: sent, delivery: 'answered' });
    expect(stored?.clearingSystemReference).toMatch(/^RTR\d+/);
  });

  it('REJECTED: pacs.002 RJCT with the reason mapped', async () => {
    const { adapter, store } = buildAdapter(replayTransport().transport);
    const { sent } = await pay(adapter, triggerPayee(T.REJECTED_SETTLEMENT_ABORTED));
    expect(sent).toMatchObject({
      state: 'REJECTED',
      reason: { code: 'SETTLEMENT_FAILED', providerCode: 'AB04' },
    });
    expect((await store.getPayment(sent.paymentId))?.status).toEqual(sent);
  });

  it('ERROR: admi.002 message reject', async () => {
    const { adapter, store } = buildAdapter(replayTransport().transport);
    const { sent } = await pay(adapter, triggerPayee(T.MESSAGE_ERROR_SCHEMA));
    expect(sent).toMatchObject({
      state: 'ERROR',
      reason: { code: 'MALFORMED_MESSAGE', providerCode: 'FF02' },
    });
    expect(sent.reason?.message).toContain('interbank_settlement_date');
    expect((await store.getPayment(sent.paymentId))?.status).toEqual(sent);
  });

  it('PENDING: no answer to the send or to the enquiry, then settles on a later poll', async () => {
    let enquiries = 0;
    const replay = replayTransport({
      intercept: (call) => {
        if (call.kind === 'send') return timeout(call);
        if (call.kind === 'status' && ++enquiries === 1) return { status: 500, body: '' };
        return undefined;
      },
    });
    const { adapter, store } = buildAdapter(replay.transport);
    const { sent } = await pay(adapter);
    expect(sent).toEqual({ paymentId: sent.paymentId, state: 'PENDING' });
    expect(await store.getPayment(sent.paymentId)).toMatchObject({
      delivery: 'unconfirmed',
      status: { state: 'PENDING' },
    });

    expect((await adapter.getStatus(sent.paymentId)).state).toBe('SETTLED');
    expect((await store.getPayment(sent.paymentId))?.delivery).toBe('answered');
    expect(replay.count('send')).toBe(1);
  });

  it('other documented rejects map to internal reasons', async () => {
    const cases: [string, string, string][] = [
      [T.REJECTED_LIMIT, 'REJECTED', 'LIMIT_EXCEEDED'],
      [T.REJECTED_TIMEOUT, 'REJECTED', 'TECHNICAL_FAILURE'],
      [T.MESSAGE_ERROR_DECRYPTION, 'ERROR', 'MALFORMED_MESSAGE'],
      [T.MESSAGE_ERROR_DUPLICATE, 'ERROR', 'MALFORMED_MESSAGE'],
      [T.UNAUTHORISED_SIGNER, 'ERROR', 'NOT_AUTHORIZED'],
    ];
    for (const [trigger, state, code] of cases) {
      const { adapter } = buildAdapter(replayTransport().transport);
      const { sent } = await pay(adapter, triggerPayee(trigger));
      expect(sent, trigger).toMatchObject({ state, reason: { code } });
    }
  });
});

describe('RTRSimAdapter: timeouts never resend', () => {
  it('a timed-out send triggers one status enquiry and leaves exactly one payment', async () => {
    const replay = replayTransport({
      intercept: (call) => (call.kind === 'send' ? timeout(call) : undefined),
    });
    const { adapter } = buildAdapter(replay.transport);
    const { input, sent } = await pay(adapter);

    expect(sent.state).toBe('SETTLED');
    expect(replay.count('send')).toBe(1);
    expect(replay.count('status')).toBe(1);

    // The enquiry asks about the very message that timed out.
    const pacs008 = JSON.parse(replay.calls.find((c) => c.kind === 'send')!.request.body);
    const pacs028 = JSON.parse(replay.calls.find((c) => c.kind === 'status')!.request.body);
    const original = pacs028.fi_to_fi_payment_status_request.transaction_information;
    expect(original.original_uetr).toBe(sent.paymentId);
    expect(original.original_group_information.original_message_identification).toBe(
      pacs008.business_application_header.business_message_identifier,
    );

    // Retrying with the same key returns the same payment and sends nothing.
    const retry = await adapter.sendPayment(input);
    expect(retry).toEqual(sent);
    expect(replay.count('send')).toBe(1);
  });

  it('a retry while still unconfirmed enquires instead of resending', async () => {
    const replay = replayTransport({
      intercept: (call) => (call.kind !== 'token' ? timeout(call) : undefined),
    });
    const { adapter } = buildAdapter(replay.transport);
    const { input, sent } = await pay(adapter);
    expect(sent.state).toBe('PENDING');

    for (let i = 0; i < 3; i++)
      expect((await adapter.sendPayment(input)).paymentId).toBe(sent.paymentId);
    expect(replay.count('send')).toBe(1);
    expect(replay.count('status')).toBe(4);
  });

  it('concurrent sends with one key create one payment', async () => {
    const replay = replayTransport();
    const { adapter } = buildAdapter(replay.transport);
    const { payeeRef } = await adapter.createPayee(payee());
    const input = {
      payeeRef,
      amountCents: cents(185000),
      idempotencyKey: 'same',
      remittanceReference: 'RENT-1',
    };
    const results = await Promise.all([1, 2, 3].map(() => adapter.sendPayment(input)));
    expect(new Set(results.map((r) => r.paymentId)).size).toBe(1);
    expect(replay.count('send')).toBe(1);
  });

  it('a 5xx on send is treated like a timeout: enquire, do not resend', async () => {
    const replay = replayTransport({
      intercept: (call) => (call.kind === 'send' ? { status: 502, body: '' } : undefined),
    });
    const { adapter } = buildAdapter(replay.transport);
    const { sent } = await pay(adapter);
    expect(sent.state).toBe('SETTLED');
    expect(replay.count('send')).toBe(1);
    expect(replay.count('status')).toBe(1);
  });

  it('a response about a different payment is not trusted', async () => {
    const replay = replayTransport({
      intercept: (call) =>
        call.kind === 'send'
          ? {
              status: 200,
              body: JSON.stringify({
                fi_to_fi_payment_status_report: {
                  transaction_information_and_status: {
                    original_uetr: '00000000-0000-4000-8000-000000000000',
                    original_end_to_end_identification: 'RENT-2026-12-UNIT1',
                    transaction_status: 'RJCT',
                  },
                },
              }),
            }
          : undefined,
    });
    const { adapter } = buildAdapter(replay.transport);
    const { sent } = await pay(adapter);
    expect(sent.state).toBe('SETTLED'); // from the enquiry, not the mismatched RJCT
    expect(replay.count('status')).toBe(1);
  });
});

describe('RTRSimAdapter: status enquiry outcomes', () => {
  async function unconfirmedPayment(trigger: string) {
    let sends = 0;
    const replay = replayTransport({
      intercept: (call) => {
        if (call.kind === 'send') {
          sends++;
          return timeout(call);
        }
        // The first enquiry (right after the timeout) also gets no answer.
        if (call.kind === 'status' && replay.count('status') === 1) return timeout(call);
        return undefined;
      },
    });
    const { adapter, store } = buildAdapter(replay.transport);
    const { sent } = await pay(adapter, triggerPayee(trigger));
    expect(sent.state).toBe('PENDING');
    return { adapter, store, sent, sends: () => sends };
  }

  it('AG09 (never received) ends the payment as REJECTED, undeliverable', async () => {
    const { adapter, sent } = await unconfirmedPayment(T.ENQUIRY_NEVER_RECEIVED);
    expect(await adapter.getStatus(sent.paymentId)).toMatchObject({
      state: 'REJECTED',
      reason: { code: 'UNDELIVERABLE', providerCode: 'AG09' },
    });
  });

  it('AG08 (enquiry not authorised) throws and leaves the payment PENDING', async () => {
    const { adapter, store, sent } = await unconfirmedPayment(T.ENQUIRY_NOT_AUTHORISED);
    await expect(adapter.getStatus(sent.paymentId)).rejects.toThrow(/AG08/);
    expect((await store.getPayment(sent.paymentId))?.status.state).toBe('PENDING');
  });

  it('an enquiry HTTP 500 keeps the payment PENDING for the next poll', async () => {
    const { adapter, sent } = await unconfirmedPayment(T.ENQUIRY_SERVER_ERROR);
    expect((await adapter.getStatus(sent.paymentId)).state).toBe('PENDING');
  });

  it('a final payment is never re-enquired (the sandbox would answer ACSP for anything)', async () => {
    const replay = replayTransport();
    const { adapter } = buildAdapter(replay.transport);
    const { sent } = await pay(adapter, triggerPayee(T.MESSAGE_ERROR_SCHEMA));
    for (let i = 0; i < 3; i++) expect(await adapter.getStatus(sent.paymentId)).toEqual(sent);
    expect(replay.count('status')).toBe(0);
  });
});

describe('RTRSimAdapter: requests', () => {
  it('sends the amount as an exact two-decimal JSON number, never via a float', async () => {
    const replay = replayTransport();
    const { adapter } = buildAdapter(replay.transport);
    await pay(adapter);
    expect(replay.calls.find((c) => c.kind === 'send')!.request.body).toContain(
      '"interbank_settlement_amount":{"currency":"CAD","amount":1850.00}',
    );
  });

  it('converts every cent value exactly', () => {
    const table: [number, string][] = [
      [1, '0.01'],
      [10, '0.10'],
      [99, '0.99'],
      [100, '1.00'],
      [185000, '1850.00'],
      [9999999999, '99999999.99'],
    ];
    for (const [input, literal] of table)
      expect(centsToDecimalLiteral(input as Cents)).toBe(literal);
    for (let c = 1; c < 5000; c += 7) {
      const literal = centsToDecimalLiteral(c as Cents);
      expect(literal).toMatch(/^\d+\.\d{2}$/);
      expect(Number(literal.replace('.', ''))).toBe(c);
    }
  });

  it('builds a pacs.008 that parses as JSON with the amount as a number', () => {
    const body = buildCreditTransfer({
      messageId: 'm1',
      uetr: 'u1',
      endToEndId: 'e1',
      amount: cents(5),
      createdAt: new Date('2026-12-01T12:00:00.000Z'),
      participantId: '111',
      debtorName: 'D',
      debtorAccount: 'DA',
      creditorInstitution: '999',
      creditorName: 'C',
      creditorAccount: 'CA',
      remittance: 'R',
    });
    const tx =
      JSON.parse(body).fi_to_fi_customer_credit_transfer.credit_transfer_transaction_information;
    expect(tx.interbank_settlement_amount).toEqual({ currency: 'CAD', amount: 0.05 });
    expect(tx.interbank_settlement_date).toBe('2026-12-01');
    expect(tx.remittance_information).toEqual({ unstructured: ['R'] });
  });

  it('uses the remittance reference as the end-to-end id for ordinary payees', async () => {
    const replay = replayTransport();
    const { adapter } = buildAdapter(replay.transport);
    await pay(adapter);
    const tx = JSON.parse(replay.calls.find((c) => c.kind === 'send')!.request.body)
      .fi_to_fi_customer_credit_transfer.credit_transfer_transaction_information;
    expect(tx.payment_identification.end_to_end_identification).toBe('RENT-2026-12-UNIT1');
    expect(tx.creditor_account.identification.other.identification).toBe('00000-0000002');
    expect(
      tx.instructed_agent.financial_institution_identification.clearing_system_member_identification
        .member_identification,
    ).toBe('999');
  });

  it('rejects remittance references the RTR cannot carry', async () => {
    const { adapter } = buildAdapter(replayTransport().transport);
    const { payeeRef } = await adapter.createPayee(payee());
    await expect(
      adapter.sendPayment({
        payeeRef,
        amountCents: cents(100),
        idempotencyKey: 'k',
        remittanceReference: 'X'.repeat(36),
      }),
    ).rejects.toThrow(/35/);
  });

  it('refuses webhooks: the RTR sandbox sends none', async () => {
    const { adapter } = buildAdapter(replayTransport().transport);
    expect(await adapter.handleWebhook({ rawBody: Buffer.from('{}'), headers: {} })).toEqual({
      verified: false,
      rejection: 'UNSUPPORTED',
    });
  });
});

describe('RTRSimAdapter: auth and refusals', () => {
  it('caches the token and refreshes it before expiry', async () => {
    let clock = Date.parse('2026-12-01T00:00:00Z');
    const replay = replayTransport();
    const { adapter } = buildAdapter(replay.transport, () => new Date(clock));
    await pay(adapter, payee(), 'a');
    await pay(adapter, payee(), 'b');
    expect(replay.count('token')).toBe(1);

    clock += 1799_000 - 30_000; // inside the 60 s refresh margin
    await pay(adapter, payee(), 'c');
    expect(replay.count('token')).toBe(2);
  });

  it('on 401 refreshes the token and retries once', async () => {
    let refused = false;
    const replay = replayTransport({
      intercept: (call) => {
        if (call.kind === 'send' && !refused) {
          refused = true;
          return { status: 401, body: '' };
        }
        return undefined;
      },
    });
    const { adapter } = buildAdapter(replay.transport);
    const { sent } = await pay(adapter);
    expect(sent.state).toBe('SETTLED');
    expect(replay.count('token')).toBe(2);
    expect(replay.count('send')).toBe(2);
  });

  it('retries 429 with backoff, then gives up as undeliverable', async () => {
    const replay = replayTransport({
      intercept: (call) => (call.kind === 'send' ? { status: 429, body: '' } : undefined),
    });
    const { adapter } = buildAdapter(replay.transport);
    const { sent } = await pay(adapter);
    expect(sent).toMatchObject({
      state: 'ERROR',
      reason: { code: 'UNDELIVERABLE', providerCode: 'HTTP_429' },
    });
    expect(replay.count('send')).toBe(3);
  });

  it('shares one in-flight token request between concurrent callers', async () => {
    let calls = 0;
    const provider = new TokenProvider({
      tokenUrl: 'https://example.test/token',
      consumerKey: 'k',
      consumerSecret: 's',
      timeoutMs: 1000,
      transport: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return { status: 200, body: JSON.stringify({ access_token: 't', expires_in: '1799' }) };
      },
    });
    expect(await Promise.all([provider.get(), provider.get(), provider.get()])).toEqual([
      't',
      't',
      't',
    ]);
    expect(calls).toBe(1);
  });
});

describe('RTR config and transport', () => {
  it('defaults to the sandbox and requires credentials', () => {
    const config = loadRtrConfig({ RTR_CONSUMER_KEY: 'k', RTR_CONSUMER_SECRET: 's' });
    expect(config.baseUrl).toBe('https://api.payments.ca/rtr-sandbox');
    expect(() => loadRtrConfig({})).toThrow(ConfigError);
  });

  it('refuses a non-sandbox base URL', () => {
    for (const url of ['https://api.payments.ca/rtr', 'http://api.payments.ca/rtr-sandbox']) {
      expect(() =>
        loadRtrConfig({ RTR_CONSUMER_KEY: 'k', RTR_CONSUMER_SECRET: 's', RTR_BASE_URL: url }),
      ).toThrow(ConfigError);
    }
  });

  it('fetchTransport turns a hung request into TransportTimeoutError', async () => {
    const server = createServer(() => undefined); // never responds
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(
        fetchTransport({
          url: `http://127.0.0.1:${port}/`,
          headers: {},
          body: '{}',
          timeoutMs: 100,
        }),
      ).rejects.toBeInstanceOf(TransportTimeoutError);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
