import type { Cents } from '../money';

/**
 * The single payment interface. The rest of the backend talks to providers only
 * through this file; provider types, URLs and status codes stay inside
 * src/payments/adapters/<name>/ (enforced by lint).
 */

/** Internal state set every adapter maps to. Only SETTLED is final success. */
export const PAYMENT_STATES = ['PENDING', 'SETTLED', 'REJECTED', 'ERROR'] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

/** States that never change once reached. */
export function isFinalState(state: PaymentState): boolean {
  return state !== 'PENDING';
}

/**
 * Internal reason categories. Adapters map provider reason codes onto these.
 * The set is deliberately small until each sandbox's real codes are read from
 * its documentation (see docs/open-questions.md).
 */
export const REASON_CODES = [
  'INSUFFICIENT_FUNDS',
  'ACCOUNT_CLOSED',
  'INVALID_ACCOUNT',
  'LIMIT_EXCEEDED',
  'NOT_AUTHORIZED',
  'RECEIVER_REJECTED',
  'SETTLEMENT_FAILED',
  'TECHNICAL_FAILURE',
  'MALFORMED_MESSAGE',
  'UNDELIVERABLE',
  'OTHER',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface PaymentReason {
  code: ReasonCode;
  message: string;
  /** Raw provider code, kept as an opaque string for audit. Never branch on it outside an adapter. */
  providerCode?: string;
}

/** Canadian account identifiers. Synthetic values only in this build. */
export interface AccountIdentifiers {
  institutionNumber: string;
  transitNumber: string;
  accountNumber: string;
}

export interface CreatePayeeInput {
  name: string;
  account: AccountIdentifiers;
}

export interface PayeeRef {
  payeeRef: string;
}

export interface SendPaymentInput {
  payeeRef: string;
  amountCents: Cents;
  /** A retry with the same key must never create a second payment. */
  idempotencyKey: string;
  remittanceReference: string;
}

export interface PaymentStatus {
  paymentId: string;
  state: PaymentState;
  /** Present when state is REJECTED or ERROR. */
  reason?: PaymentReason;
}

export interface WebhookRequest {
  /** Exact bytes received; signatures are verified over these, never over re-serialised JSON. */
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export type WebhookRejection = 'BAD_SIGNATURE' | 'MALFORMED' | 'UNKNOWN_PAYMENT' | 'UNSUPPORTED';

export type WebhookResult =
  | { verified: true; eventId: string; status: PaymentStatus }
  | { verified: false; rejection: WebhookRejection };

export interface PaymentProvider {
  /** Adapter name as selected by PAYMENT_ADAPTER. */
  readonly name: string;

  createPayee(input: CreatePayeeInput): Promise<PayeeRef>;

  /**
   * Idempotent on `idempotencyKey`: the same key with the same input returns the
   * original payment; the same key with different input throws
   * IdempotencyConflictError. On a timeout an adapter queries status and never resends.
   */
  sendPayment(input: SendPaymentInput): Promise<PaymentStatus>;

  getStatus(paymentId: string): Promise<PaymentStatus>;

  /** Returns a verified state change, or a rejection that must change no state. */
  handleWebhook(request: WebhookRequest): Promise<WebhookResult>;
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnknownPayeeError extends ProviderError {
  constructor(payeeRef: string) {
    super(`Unknown payee: ${payeeRef}`);
  }
}

export class UnknownPaymentError extends ProviderError {
  constructor(paymentId: string) {
    super(`Unknown payment: ${paymentId}`);
  }
}

export class IdempotencyConflictError extends ProviderError {
  constructor(idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was already used with different payment details`);
  }
}

export class AdapterNotImplementedError extends ProviderError {
  constructor(adapter: string) {
    super(`Payment adapter "${adapter}" is not implemented yet`);
  }
}
