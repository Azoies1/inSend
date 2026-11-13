import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidAmountError, type Cents } from '../../src/money';
import {
  IdempotencyConflictError,
  PAYMENT_STATES,
  REASON_CODES,
  UnknownPaymentError,
  type CreatePayeeInput,
  type PaymentProvider,
  type PaymentState,
  type PaymentStatus,
  type WebhookRequest,
} from '../../src/payments/provider';

/**
 * The shared contract every payment adapter must pass. It is written purely
 * against the PaymentProvider interface; adapter specifics live in the harness.
 * Adding an adapter means writing a harness, never editing this file.
 */

/** A payee and amount that, sent through this adapter, end in a known outcome. */
export interface ContractScenario {
  payee: CreatePayeeInput;
  amountCents: Cents;
}

export interface ContractContext {
  provider: PaymentProvider;
  /**
   * Arranges for the next payment to end in `outcome` and returns the synthetic
   * payee and amount to send. Sandboxes usually key outcomes off magic amounts
   * or accounts; the fake just plans it.
   */
  scenario(outcome: 'SETTLED' | 'REJECTED'): Promise<ContractScenario>;
  /** Optional: a payment that stays PENDING, so webhook tests can prove no state changed. */
  pendingScenario?(): Promise<ContractScenario>;
  /** A well-formed webhook claiming `state` for the payment, with an invalid signature. */
  badSignatureWebhook(paymentId: string, state: PaymentState): Promise<WebhookRequest>;
  /** Optional: a correctly signed webhook, for adapters whose provider sends webhooks. */
  validWebhook?(paymentId: string, state: PaymentState): Promise<WebhookRequest>;
  teardown?(): Promise<void>;
}

export interface ContractHarness {
  adapterName: string;
  create(): Promise<ContractContext>;
  /** How long a payment may take to leave PENDING. Default 2000 ms. */
  finalTimeoutMs?: number;
}

export function runAdapterContract(harness: ContractHarness): void {
  const finalTimeoutMs = harness.finalTimeoutMs ?? 2000;

  describe(`PaymentProvider contract: ${harness.adapterName}`, () => {
    let ctx: ContractContext;
    let provider: PaymentProvider;

    beforeEach(async () => {
      ctx = await harness.create();
      provider = ctx.provider;
    });

    afterEach(async () => {
      await ctx.teardown?.();
    });

    async function send(scenario: ContractScenario, idempotencyKey: string = randomUUID()) {
      const { payeeRef } = await provider.createPayee(scenario.payee);
      const input = {
        payeeRef,
        amountCents: scenario.amountCents,
        idempotencyKey,
        remittanceReference: `RENT-${idempotencyKey.slice(0, 8)}`,
      };
      return { input, sent: await provider.sendPayment(input) };
    }

    async function awaitFinal(paymentId: string): Promise<PaymentStatus> {
      const deadline = Date.now() + finalTimeoutMs;
      for (;;) {
        const status = await provider.getStatus(paymentId);
        if (status.state !== 'PENDING') return status;
        if (Date.now() > deadline) {
          throw new Error(`Payment ${paymentId} still PENDING after ${finalTimeoutMs} ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    it('creates a payee and returns a provider reference', async () => {
      const { payee } = await ctx.scenario('SETTLED');
      const first = await provider.createPayee(payee);
      expect(first.payeeRef).toEqual(expect.any(String));
      expect(first.payeeRef.length).toBeGreaterThan(0);
    });

    it('sends a payment and returns an id with a valid initial state', async () => {
      const { sent } = await send(await ctx.scenario('SETTLED'));
      expect(sent.paymentId).toEqual(expect.any(String));
      expect(sent.paymentId.length).toBeGreaterThan(0);
      expect(PAYMENT_STATES).toContain(sent.state);
    });

    it('reports SETTLED with no reason once a payment settles', async () => {
      const { sent } = await send(await ctx.scenario('SETTLED'));
      const final = await awaitFinal(sent.paymentId);
      expect(final).toEqual({ paymentId: sent.paymentId, state: 'SETTLED' });
      // Final states are stable across further polls.
      expect(await provider.getStatus(sent.paymentId)).toEqual(final);
    });

    it('returns the original payment for a duplicate idempotency key', async () => {
      const { input, sent } = await send(await ctx.scenario('SETTLED'));
      const retry = await provider.sendPayment(input);
      expect(retry.paymentId).toBe(sent.paymentId);

      // Still the same single payment after it settles and is retried again.
      await awaitFinal(sent.paymentId);
      const lateRetry = await provider.sendPayment(input);
      expect(lateRetry.paymentId).toBe(sent.paymentId);
      expect(lateRetry.state).toBe('SETTLED');
    });

    it('refuses an idempotency key reused with different payment details', async () => {
      const { input } = await send(await ctx.scenario('SETTLED'));
      const changed = { ...input, amountCents: (input.amountCents + 1) as Cents };
      await expect(provider.sendPayment(changed)).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it('reports REJECTED with an internal reason code for a rejected payment', async () => {
      const { sent } = await send(await ctx.scenario('REJECTED'));
      const final = await awaitFinal(sent.paymentId);
      expect(final.state).toBe('REJECTED');
      expect(REASON_CODES).toContain(final.reason?.code);
      expect(final.reason?.message).toEqual(expect.any(String));
    });

    it('rejects a webhook with a bad signature and changes no state', async () => {
      const usePending = ctx.pendingScenario !== undefined;
      const scenario = usePending ? await ctx.pendingScenario!() : await ctx.scenario('SETTLED');
      const { sent } = await send(scenario);
      const before = usePending
        ? await provider.getStatus(sent.paymentId)
        : await awaitFinal(sent.paymentId);

      // Claim a state the payment is not in, so any change would be visible.
      const claimed: PaymentState = before.state === 'PENDING' ? 'SETTLED' : 'REJECTED';
      const result = await provider.handleWebhook(
        await ctx.badSignatureWebhook(sent.paymentId, claimed),
      );

      expect(result.verified).toBe(false);
      expect(await provider.getStatus(sent.paymentId)).toEqual(before);
    });

    it('rejects amounts that are not positive integer cents', async () => {
      const scenario = await ctx.scenario('SETTLED');
      for (const bad of [10.5, 0, -100, Number.NaN]) {
        await expect(send({ ...scenario, amountCents: bad as Cents })).rejects.toBeInstanceOf(
          InvalidAmountError,
        );
      }
    });

    it('throws UnknownPaymentError for a payment id it never issued', async () => {
      await expect(provider.getStatus(`missing-${randomUUID()}`)).rejects.toBeInstanceOf(
        UnknownPaymentError,
      );
    });

    it('applies a correctly signed webhook (when the provider sends webhooks)', async (test) => {
      if (!ctx.validWebhook || !ctx.pendingScenario) return test.skip();
      const { sent } = await send(await ctx.pendingScenario());
      const result = await provider.handleWebhook(
        await ctx.validWebhook(sent.paymentId, 'SETTLED'),
      );
      expect(result).toMatchObject({
        verified: true,
        status: { paymentId: sent.paymentId, state: 'SETTLED' },
      });
      expect((await provider.getStatus(sent.paymentId)).state).toBe('SETTLED');
    });
  });
}
