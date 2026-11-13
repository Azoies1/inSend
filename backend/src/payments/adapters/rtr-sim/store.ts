import type { AccountIdentifiers, PaymentStatus, SendPaymentInput } from '../../provider';

/**
 * Whether the RTR Exchange has answered the pacs.008:
 * - unconfirmed: claimed and possibly sent, no answer yet (timeout, crash,
 *   5xx). Resolved only by pacs.028 enquiry, never by resending.
 * - answered: the Exchange returned a pacs.002 or admi.002, or definitively
 *   refused the request.
 */
export type DeliveryState = 'unconfirmed' | 'answered';

export interface RtrPaymentRecord {
  /** The UETR. Doubles as the internal payment id. */
  paymentId: string;
  idempotencyKey: string;
  input: SendPaymentInput;
  messageId: string;
  endToEndId: string;
  creditor: { name: string; account: AccountIdentifiers };
  delivery: DeliveryState;
  status: PaymentStatus;
  clearingSystemReference?: string;
}

export interface RtrPayeeRecord {
  name: string;
  account: AccountIdentifiers;
}

/**
 * Adapter-owned state. The sandbox keeps none (it answers enquiries from
 * trigger values alone), so idempotency and final states live here.
 * InMemoryRtrStore is enough for Goal 2; a Postgres-backed store is listed in
 * docs/production-gaps.md.
 */
export interface RtrStore {
  savePayee(payeeRef: string, payee: RtrPayeeRecord): Promise<void>;
  getPayee(payeeRef: string): Promise<RtrPayeeRecord | undefined>;
  /** Inserts unless the idempotency key exists; returns the stored record either way. */
  claimPayment(record: RtrPaymentRecord): Promise<{ record: RtrPaymentRecord; created: boolean }>;
  getPayment(paymentId: string): Promise<RtrPaymentRecord | undefined>;
  updatePayment(record: RtrPaymentRecord): Promise<void>;
}

export class InMemoryRtrStore implements RtrStore {
  private readonly payees = new Map<string, RtrPayeeRecord>();
  private readonly payments = new Map<string, RtrPaymentRecord>();
  private readonly idByKey = new Map<string, string>();

  async savePayee(payeeRef: string, payee: RtrPayeeRecord): Promise<void> {
    this.payees.set(payeeRef, structuredClone(payee));
  }

  async getPayee(payeeRef: string): Promise<RtrPayeeRecord | undefined> {
    const payee = this.payees.get(payeeRef);
    return payee && structuredClone(payee);
  }

  async claimPayment(record: RtrPaymentRecord) {
    const existingId = this.idByKey.get(record.idempotencyKey);
    if (existingId)
      return { record: structuredClone(this.payments.get(existingId)!), created: false };
    this.payments.set(record.paymentId, structuredClone(record));
    this.idByKey.set(record.idempotencyKey, record.paymentId);
    return { record: structuredClone(record), created: true };
  }

  async getPayment(paymentId: string): Promise<RtrPaymentRecord | undefined> {
    const record = this.payments.get(paymentId);
    return record && structuredClone(record);
  }

  async updatePayment(record: RtrPaymentRecord): Promise<void> {
    if (!this.payments.has(record.paymentId)) throw new Error(`No payment ${record.paymentId}`);
    this.payments.set(record.paymentId, structuredClone(record));
  }
}
