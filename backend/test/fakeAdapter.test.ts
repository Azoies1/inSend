import { describe, expect, it } from 'vitest';
import { cents } from '../src/money';
import { FAKE_SIGNATURE_HEADER, FakeAdapter } from '../src/payments/adapters/fake/FakeAdapter';
import { UnknownPayeeError } from '../src/payments/provider';

async function sendOne(fake: FakeAdapter, idempotencyKey = 'key-1') {
  const { payeeRef } = await fake.createPayee({
    name: 'Synthetic Landlord One',
    account: { institutionNumber: '999', transitNumber: '00000', accountNumber: '0000001' },
  });
  return fake.sendPayment({
    payeeRef,
    amountCents: cents(185000),
    idempotencyKey,
    remittanceReference: 'RENT-TEST',
  });
}

describe('FakeAdapter controls', () => {
  it('settles and rejects on demand', async () => {
    const fake = new FakeAdapter({ defaultOutcome: { state: 'PENDING' } });
    const a = await sendOne(fake, 'a');
    const b = await sendOne(fake, 'b');

    fake.settle(a.paymentId);
    fake.reject(b.paymentId, { code: 'ACCOUNT_CLOSED', message: 'Closed' });

    expect(await fake.getStatus(a.paymentId)).toEqual({ paymentId: a.paymentId, state: 'SETTLED' });
    expect(await fake.getStatus(b.paymentId)).toEqual({
      paymentId: b.paymentId,
      state: 'REJECTED',
      reason: { code: 'ACCOUNT_CLOSED', message: 'Closed' },
    });
  });

  it('creates exactly one payment across retries with the same key', async () => {
    const fake = new FakeAdapter();
    await sendOne(fake, 'same');
    await sendOne(fake, 'same').catch(() => undefined); // different payeeRef: conflict, no new payment
    expect(fake.paymentCount()).toBe(1);
  });

  it('never leaves a final state', async () => {
    const fake = new FakeAdapter();
    const sent = await sendOne(fake);
    fake.settle(sent.paymentId);
    fake.reject(sent.paymentId);
    await fake.handleWebhook(fake.buildWebhook(sent.paymentId, 'REJECTED'));
    expect((await fake.getStatus(sent.paymentId)).state).toBe('SETTLED');
  });

  it('can end a payment in ERROR with a reason', async () => {
    const fake = new FakeAdapter();
    fake.planNext({ state: 'ERROR' });
    const sent = await sendOne(fake);
    const status = await fake.getStatus(sent.paymentId);
    expect(status.state).toBe('ERROR');
    expect(status.reason?.code).toBe('MALFORMED_MESSAGE');
  });

  it('rejects malformed, unsigned and unknown-payment webhooks', async () => {
    const fake = new FakeAdapter({ defaultOutcome: { state: 'PENDING' } });
    const sent = await sendOne(fake);

    const unsigned = fake.buildWebhook(sent.paymentId, 'SETTLED');
    delete unsigned.headers[FAKE_SIGNATURE_HEADER];
    expect(await fake.handleWebhook(unsigned)).toEqual({
      verified: false,
      rejection: 'BAD_SIGNATURE',
    });

    // Signed over the original bytes, then the body is tampered with.
    const tampered = fake.buildWebhook(sent.paymentId, 'REJECTED');
    tampered.rawBody = Buffer.from(tampered.rawBody.toString().replace('REJECTED', 'SETTLED'));
    expect(await fake.handleWebhook(tampered)).toEqual({
      verified: false,
      rejection: 'BAD_SIGNATURE',
    });

    expect(await fake.handleWebhook(fake.buildWebhook('fake_pay_missing', 'SETTLED'))).toEqual({
      verified: false,
      rejection: 'UNKNOWN_PAYMENT',
    });

    expect((await fake.getStatus(sent.paymentId)).state).toBe('PENDING');
  });

  it('refuses to pay an unknown payee', async () => {
    const fake = new FakeAdapter();
    await expect(
      fake.sendPayment({
        payeeRef: 'fake_payee_missing',
        amountCents: cents(100),
        idempotencyKey: 'k',
        remittanceReference: 'RENT-TEST',
      }),
    ).rejects.toBeInstanceOf(UnknownPayeeError);
  });
});
