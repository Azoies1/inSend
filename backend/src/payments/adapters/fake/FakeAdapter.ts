import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { assertPayableAmount } from '../../../money';
import {
  IdempotencyConflictError,
  PAYMENT_STATES,
  REASON_CODES,
  UnknownPayeeError,
  UnknownPaymentError,
  isFinalState,
  type CreatePayeeInput,
  type PayeeRef,
  type PaymentProvider,
  type PaymentReason,
  type PaymentState,
  type PaymentStatus,
  type SendPaymentInput,
  type WebhookRequest,
  type WebhookResult,
} from '../../provider';

export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';

/** Where a payment ends up once it resolves. PENDING means it never resolves on its own. */
export type FakeOutcome =
  | { state: 'SETTLED' }
  | { state: 'PENDING' }
  | { state: 'REJECTED' | 'ERROR'; reason?: PaymentReason };

const DEFAULT_REASONS: Record<'REJECTED' | 'ERROR', PaymentReason> = {
  REJECTED: { code: 'INSUFFICIENT_FUNDS', message: 'Fake rejection', providerCode: 'FAKE-NSF' },
  ERROR: { code: 'MALFORMED_MESSAGE', message: 'Fake message error', providerCode: 'FAKE-ERR' },
};

interface FakePayment {
  input: SendPaymentInput;
  status: PaymentStatus;
  outcome: FakeOutcome;
}

export interface FakeAdapterOptions {
  /** Not a real secret: the fake signs and verifies its own webhooks with it. */
  webhookSecret?: string;
  /** Outcome for payments with nothing planned. Defaults to SETTLED. */
  defaultOutcome?: FakeOutcome;
}

/**
 * In-memory provider for tests and local runs. A payment is PENDING when sent
 * and resolves to its planned outcome on the first status poll, or earlier via
 * settle(), reject() or a signed webhook.
 */
export class FakeAdapter implements PaymentProvider {
  readonly name = 'fake';

  private readonly webhookSecret: string;
  private readonly defaultOutcome: FakeOutcome;
  private readonly planned: FakeOutcome[] = [];
  private readonly payees = new Map<string, CreatePayeeInput>();
  private readonly payments = new Map<string, FakePayment>();
  private readonly paymentIdByKey = new Map<string, string>();

  constructor(options: FakeAdapterOptions = {}) {
    this.webhookSecret = options.webhookSecret ?? 'fake-webhook-secret';
    this.defaultOutcome = options.defaultOutcome ?? { state: 'SETTLED' };
  }

  // --- PaymentProvider -------------------------------------------------------

  async createPayee(input: CreatePayeeInput): Promise<PayeeRef> {
    const payeeRef = `fake_payee_${randomUUID()}`;
    this.payees.set(payeeRef, structuredClone(input));
    return { payeeRef };
  }

  async sendPayment(input: SendPaymentInput): Promise<PaymentStatus> {
    assertPayableAmount(input.amountCents);
    if (!this.payees.has(input.payeeRef)) throw new UnknownPayeeError(input.payeeRef);

    const existingId = this.paymentIdByKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.mustGet(existingId);
      if (!sameInput(existing.input, input)) {
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
      return { ...existing.status };
    }

    const paymentId = `fake_pay_${randomUUID()}`;
    const payment: FakePayment = {
      input: { ...input },
      status: { paymentId, state: 'PENDING' },
      outcome: this.planned.shift() ?? this.defaultOutcome,
    };
    this.payments.set(paymentId, payment);
    this.paymentIdByKey.set(input.idempotencyKey, paymentId);
    return { ...payment.status };
  }

  async getStatus(paymentId: string): Promise<PaymentStatus> {
    const payment = this.mustGet(paymentId);
    const { outcome } = payment;
    if (outcome.state !== 'PENDING') {
      this.transition(payment, outcome.state, 'reason' in outcome ? outcome.reason : undefined);
    }
    return { ...payment.status };
  }

  async handleWebhook(request: WebhookRequest): Promise<WebhookResult> {
    const signature = request.headers[FAKE_SIGNATURE_HEADER];
    if (typeof signature !== 'string' || !this.signatureMatches(request.rawBody, signature)) {
      return { verified: false, rejection: 'BAD_SIGNATURE' };
    }

    const event = parseEvent(request.rawBody);
    if (!event) return { verified: false, rejection: 'MALFORMED' };

    const payment = this.payments.get(event.paymentId);
    if (!payment) return { verified: false, rejection: 'UNKNOWN_PAYMENT' };

    this.transition(payment, event.state, event.reason);
    return { verified: true, eventId: event.eventId, status: { ...payment.status } };
  }

  // --- Test controls ---------------------------------------------------------

  /** Queue the outcome for the next payment sent. Calls queue up in order. */
  planNext(outcome: FakeOutcome): void {
    this.planned.push(outcome);
  }

  settle(paymentId: string): void {
    this.transition(this.mustGet(paymentId), 'SETTLED');
  }

  reject(paymentId: string, reason?: PaymentReason): void {
    this.transition(this.mustGet(paymentId), 'REJECTED', reason);
  }

  /** Number of distinct payments created, for asserting that retries did not duplicate. */
  paymentCount(): number {
    return this.payments.size;
  }

  /** Builds a webhook request signed the way this adapter expects. */
  buildWebhook(
    paymentId: string,
    state: PaymentState,
    options: { reason?: PaymentReason; eventId?: string; secret?: string } = {},
  ): WebhookRequest {
    const rawBody = Buffer.from(
      JSON.stringify({
        eventId: options.eventId ?? `fake_evt_${randomUUID()}`,
        paymentId,
        state,
        ...(options.reason ? { reason: options.reason } : {}),
      }),
    );
    return {
      rawBody,
      headers: { [FAKE_SIGNATURE_HEADER]: sign(rawBody, options.secret ?? this.webhookSecret) },
    };
  }

  // --- Internals -------------------------------------------------------------

  private mustGet(paymentId: string): FakePayment {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new UnknownPaymentError(paymentId);
    return payment;
  }

  /** Final states never change; late or duplicate signals are ignored. */
  private transition(payment: FakePayment, state: PaymentState, reason?: PaymentReason): void {
    if (isFinalState(payment.status.state)) return;
    if (state === 'REJECTED' || state === 'ERROR') {
      payment.status = {
        paymentId: payment.status.paymentId,
        state,
        reason: reason ?? DEFAULT_REASONS[state],
      };
    } else {
      payment.status = { paymentId: payment.status.paymentId, state };
    }
  }

  private signatureMatches(rawBody: Buffer, signature: string): boolean {
    const expected = Buffer.from(sign(rawBody, this.webhookSecret), 'hex');
    const actual = Buffer.from(signature, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

function sign(rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function sameInput(a: SendPaymentInput, b: SendPaymentInput): boolean {
  return (
    a.payeeRef === b.payeeRef &&
    a.amountCents === b.amountCents &&
    a.remittanceReference === b.remittanceReference
  );
}

interface FakeEvent {
  eventId: string;
  paymentId: string;
  state: PaymentState;
  reason?: PaymentReason;
}

function parseEvent(rawBody: Buffer): FakeEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const { eventId, paymentId, state, reason } = body as Record<string, unknown>;
  if (typeof eventId !== 'string' || typeof paymentId !== 'string') return null;
  if (!PAYMENT_STATES.includes(state as PaymentState)) return null;
  if (reason !== undefined && !isReason(reason)) return null;
  return { eventId, paymentId, state: state as PaymentState, reason };
}

function isReason(value: unknown): value is PaymentReason {
  if (typeof value !== 'object' || value === null) return false;
  const { code, message } = value as Record<string, unknown>;
  return REASON_CODES.includes(code as PaymentReason['code']) && typeof message === 'string';
}
