import { randomUUID } from 'node:crypto';
import { assertPayableAmount } from '../../../money';
import {
  IdempotencyConflictError,
  ProviderError,
  UnknownPayeeError,
  UnknownPaymentError,
  isFinalState,
  type CreatePayeeInput,
  type PayeeRef,
  type PaymentProvider,
  type PaymentReason,
  type PaymentStatus,
  type SendPaymentInput,
  type WebhookRequest,
  type WebhookResult,
} from '../../provider';
import { TokenProvider } from './auth';
import type { RtrConfig } from './config';
import { MAX35, buildCreditTransfer, buildStatusRequest, newMessageId } from './iso';
import {
  NO_CLEARING_REFERENCE,
  mapReason,
  mapTransactionStatus,
  parseResponse,
  type RtrResponse,
} from './mapping';
import { InMemoryRtrStore, type RtrPaymentRecord, type RtrStore } from './store';
import {
  TransportTimeoutError,
  fetchTransport,
  type HttpResponse,
  type HttpTransport,
} from './transport';

/**
 * Sandbox outcome triggers from the RTR Sandbox API Test Scenarios v3.0. The
 * sandbox decides an outcome from end_to_end_identification alone, so a
 * synthetic payee whose account number is one of these values makes every
 * payment to it carry that trigger. Any other payee gets its own end-to-end id
 * (the remittance reference) and the sandbox's default outcome, ACSP.
 */
export const RTR_SANDBOX_TRIGGERS = {
  /** pacs.002 RJCT AB04 on send and on enquiry. */
  REJECTED_SETTLEMENT_ABORTED: '1234567890112',
  /** pacs.002 RJCT AM02. */
  REJECTED_LIMIT: '1234567890116',
  /** admi.002 FF02 schema failure. */
  MESSAGE_ERROR_SCHEMA: '1234567897771',
  /** admi.002 DS09 decryption failure. */
  MESSAGE_ERROR_DECRYPTION: '1234567897772',
  /** HTTP 401: signer certificate not valid. */
  UNAUTHORISED_SIGNER: '1234567897773',
  /** admi.002 DUPL. */
  MESSAGE_ERROR_DUPLICATE: '1234567897774',
  /** pacs.002 RJCT AB03 transaction timeout. */
  REJECTED_TIMEOUT: '1234567897777',
  /** Enquiry only: RJCT AG08, the enquirer is not authorised. */
  ENQUIRY_NOT_AUTHORISED: '1234567890113',
  /** Enquiry only: RJCT AG09, original payment never received. */
  ENQUIRY_NEVER_RECEIVED: '1234567890114',
  /** Enquiry only: HTTP 500. */
  ENQUIRY_SERVER_ERROR: '1234567898885',
} as const;

const TRIGGER_VALUES = new Set<string>(Object.values(RTR_SANDBOX_TRIGGERS));

/** HTTP statuses that mean the request was refused and not processed. */
const RETRYABLE_REFUSALS = new Set([429, 503]);
const REFUSAL_RETRIES = 2;

export class RtrRequestError extends ProviderError {}

export interface RTRSimAdapterOptions {
  config: RtrConfig;
  transport?: HttpTransport;
  store?: RtrStore;
  now?: () => Date;
  /** Waits between retries of a refused (429/503) request. */
  sleep?: (ms: number) => Promise<void>;
}

type Exchange =
  { outcome: 'response'; status: number; body: string } | { outcome: 'no-answer'; cause: string };

/**
 * PaymentProvider over the Payments Canada RTR sandbox (ISO 20022 JSON).
 *
 * - sendPayment: pacs.008, answered by pacs.002 or admi.002.
 * - getStatus: pacs.028 enquiry, answered by pacs.002 or admi.002.
 * - Never resends a pacs.008 that may have been processed. A timeout, network
 *   failure or 5xx leaves the payment unconfirmed, and only an enquiry resolves it.
 * - handleWebhook: the sandbox has no outbound notifications, so every
 *   webhook is refused and changes nothing.
 */
export class RTRSimAdapter implements PaymentProvider {
  readonly name = 'rtr-sim';

  private readonly config: RtrConfig;
  private readonly transport: HttpTransport;
  private readonly store: RtrStore;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tokens: TokenProvider;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: RTRSimAdapterOptions) {
    this.config = options.config;
    this.transport = options.transport ?? fetchTransport;
    this.store = options.store ?? new InMemoryRtrStore();
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tokens = new TokenProvider({
      tokenUrl: this.config.tokenUrl,
      consumerKey: this.config.consumerKey,
      consumerSecret: this.config.consumerSecret,
      transport: this.transport,
      timeoutMs: this.config.requestTimeoutMs,
      now: () => this.now().getTime(),
    });
  }

  // --- PaymentProvider -------------------------------------------------------

  async createPayee(input: CreatePayeeInput): Promise<PayeeRef> {
    const { institutionNumber, transitNumber, accountNumber } = input.account;
    if (!/^\d{3}$/.test(institutionNumber) || !/^\d{5}$/.test(transitNumber)) {
      throw new RtrRequestError('Institution must be 3 digits and transit 5 digits');
    }
    if (!accountNumber || `${transitNumber}-${accountNumber}`.length > 34) {
      throw new RtrRequestError('Account number is missing or too long for the RTR (max 34)');
    }
    const payeeRef = `rtr_payee_${randomUUID()}`;
    // The RTR has no payee registry; the payee lives here and is copied into each pacs.008.
    await this.store.savePayee(payeeRef, { name: input.name, account: { ...input.account } });
    return { payeeRef };
  }

  async sendPayment(input: SendPaymentInput): Promise<PaymentStatus> {
    assertPayableAmount(input.amountCents);
    return this.withLock(`key:${input.idempotencyKey}`, async () => {
      const payee = await this.store.getPayee(input.payeeRef);
      if (!payee) throw new UnknownPayeeError(input.payeeRef);
      if (!input.remittanceReference || input.remittanceReference.length > MAX35) {
        throw new RtrRequestError('Remittance reference must be 1 to 35 characters');
      }

      const uetr = randomUUID();
      const { record, created } = await this.store.claimPayment({
        paymentId: uetr,
        idempotencyKey: input.idempotencyKey,
        input: { ...input },
        messageId: newMessageId(),
        endToEndId: TRIGGER_VALUES.has(payee.account.accountNumber)
          ? payee.account.accountNumber
          : input.remittanceReference,
        creditor: payee,
        delivery: 'unconfirmed',
        status: { paymentId: uetr, state: 'PENDING' },
      });

      if (!created) {
        if (!sameInput(record.input, input))
          throw new IdempotencyConflictError(input.idempotencyKey);
        // A retry. Never resend: return what we know, or ask the Exchange.
        return this.resolve(record);
      }
      return this.deliver(record);
    });
  }

  async getStatus(paymentId: string): Promise<PaymentStatus> {
    return this.withLock(`pay:${paymentId}`, async () => {
      const record = await this.store.getPayment(paymentId);
      if (!record) throw new UnknownPaymentError(paymentId);
      return this.resolve(record);
    });
  }

  async handleWebhook(_request: WebhookRequest): Promise<WebhookResult> {
    // The RTR sandbox sends nothing to us (Exchange-to-participant flows are out
    // of the sandbox's scope), so there is no signature we could verify.
    return { verified: false, rejection: 'UNSUPPORTED' };
  }

  // --- Send ------------------------------------------------------------------

  private async deliver(record: RtrPaymentRecord): Promise<PaymentStatus> {
    const body = buildCreditTransfer({
      messageId: record.messageId,
      uetr: record.paymentId,
      endToEndId: record.endToEndId,
      amount: record.input.amountCents,
      createdAt: this.now(),
      participantId: this.config.participantId,
      debtorName: this.config.debtorName,
      debtorAccount: this.config.debtorAccount,
      creditorInstitution: record.creditor.account.institutionNumber,
      creditorName: record.creditor.name,
      creditorAccount: `${record.creditor.account.transitNumber}-${record.creditor.account.accountNumber}`,
      remittance: record.input.remittanceReference,
    });

    const exchange = await this.post('/payments', body, record.paymentId, {
      retryRefusals: true,
    });

    if (exchange.outcome === 'no-answer') {
      // Possibly processed. Find out instead of resending.
      return this.resolveAfterAmbiguousSend(record);
    }

    const { status } = exchange;
    if (status === 200) {
      const parsed = parseResponse(exchange.body);
      if (parsed && this.answersCreditTransfer(record, parsed)) {
        return this.apply(record, this.fromSendResponse(parsed));
      }
      // Unreadable or about some other message: we cannot trust it either way.
      return this.resolveAfterAmbiguousSend(record);
    }
    if (status >= 500 && !RETRYABLE_REFUSALS.has(status)) {
      return this.resolveAfterAmbiguousSend(record);
    }

    // 4xx, or 429/503 still refused after retries: not processed.
    return this.apply(record, {
      state: 'ERROR',
      reason: {
        code: status === 401 || status === 403 ? 'NOT_AUTHORIZED' : 'UNDELIVERABLE',
        message: `RTR Exchange refused the payment (HTTP ${status})`,
        providerCode: `HTTP_${status}`,
      },
    });
  }

  private answersCreditTransfer(record: RtrPaymentRecord, response: RtrResponse): boolean {
    if (response.type === 'admi.002') return response.relatedReference === record.messageId;
    return (
      response.originalUetr === record.paymentId &&
      response.originalEndToEndId === record.endToEndId &&
      (response.originalMessageId === undefined || response.originalMessageId === record.messageId)
    );
  }

  private fromSendResponse(response: RtrResponse): Resolution {
    if (response.type === 'admi.002') {
      // Message reject: the pacs.008 never became a payment.
      return { state: 'ERROR', reason: mapReason(response.reasonCode, response.description) };
    }
    return this.fromPacs002(response);
  }

  // --- Status enquiry --------------------------------------------------------

  /**
   * After a send with no usable answer, the payment exists on our side either
   * way. An enquiry that fails here must not surface as a failed send (the
   * caller might retry with a new key and pay twice), so it reports PENDING.
   */
  private async resolveAfterAmbiguousSend(record: RtrPaymentRecord): Promise<PaymentStatus> {
    try {
      return await this.resolve(record);
    } catch (error) {
      if (error instanceof RtrRequestError) return { ...record.status };
      throw error;
    }
  }

  /** Returns the stored status, enquiring only while the payment is not final. */
  private async resolve(record: RtrPaymentRecord): Promise<PaymentStatus> {
    if (isFinalState(record.status.state)) return { ...record.status };

    const body = buildStatusRequest({
      messageId: newMessageId(),
      createdAt: this.now(),
      participantId: this.config.participantId,
      creditorInstitution: record.creditor.account.institutionNumber,
      original: {
        messageId: record.messageId,
        endToEndId: record.endToEndId,
        uetr: record.paymentId,
      },
    });
    const exchange = await this.post('/payments/status', body, record.paymentId, {
      retryRefusals: false,
    });

    // Transient trouble: the payment stays PENDING and a later poll asks again.
    if (exchange.outcome === 'no-answer') return { ...record.status };
    if (exchange.status >= 500 || RETRYABLE_REFUSALS.has(exchange.status)) {
      return { ...record.status };
    }
    if (exchange.status !== 200) {
      throw new RtrRequestError(`Status enquiry refused with HTTP ${exchange.status}`);
    }

    const parsed = parseResponse(exchange.body);
    if (!parsed) return { ...record.status };
    if (parsed.type === 'admi.002') {
      // The enquiry was rejected, not the payment.
      throw new RtrRequestError(
        `Status enquiry rejected (${parsed.reasonCode ?? 'no code'}): ${parsed.description ?? ''}`.trim(),
      );
    }
    if (parsed.originalUetr !== record.paymentId) return { ...record.status };

    if (
      parsed.transactionStatus === 'RJCT' &&
      parsed.clearingSystemReference === NO_CLEARING_REFERENCE
    ) {
      if (parsed.reasonCode !== 'AG09') {
        throw new RtrRequestError(`Status enquiry rejected (${parsed.reasonCode ?? 'no code'})`);
      }
      // AG09: the Exchange never received the pacs.008, so no payment exists.
      return this.apply(record, {
        state: 'REJECTED',
        reason: mapReason('AG09', parsed.additionalInformation),
      });
    }
    return this.apply(record, this.fromPacs002(parsed));
  }

  private fromPacs002(response: Extract<RtrResponse, { type: 'pacs.002' }>): Resolution {
    const mapped = mapTransactionStatus(
      response.transactionStatus ?? '',
      response.reasonCode,
      response.additionalInformation,
    );
    switch (mapped.kind) {
      case 'SETTLED':
        return { state: 'SETTLED', clearingSystemReference: response.clearingSystemReference };
      case 'PENDING':
        return { state: 'PENDING', clearingSystemReference: response.clearingSystemReference };
      case 'REJECTED':
        return { state: 'REJECTED', reason: mapped.reason };
      case 'UNKNOWN_CODE':
        // Not a status we understand: treat as unanswered rather than guess.
        return { state: 'PENDING', unanswered: true };
    }
  }

  // --- Plumbing ----------------------------------------------------------------

  private async apply(record: RtrPaymentRecord, resolution: Resolution): Promise<PaymentStatus> {
    const status: PaymentStatus =
      resolution.state === 'REJECTED' || resolution.state === 'ERROR'
        ? { paymentId: record.paymentId, state: resolution.state, reason: resolution.reason }
        : { paymentId: record.paymentId, state: resolution.state };
    const updated: RtrPaymentRecord = {
      ...record,
      status,
      delivery: resolution.unanswered ? record.delivery : 'answered',
      ...(resolution.clearingSystemReference
        ? { clearingSystemReference: resolution.clearingSystemReference }
        : {}),
    };
    await this.store.updatePayment(updated);
    Object.assign(record, updated);
    return { ...status };
  }

  /**
   * POSTs an ISO message. Refreshes the token and retries once on 401 (the
   * gateway rejected it before the Exchange saw it). With retryRefusals, a
   * 429/503 is retried with backoff, since those mean "not processed".
   * Timeouts and network failures are never retried here.
   */
  private async post(
    path: string,
    body: string,
    uetr: string,
    options: { retryRefusals: boolean },
  ): Promise<Exchange> {
    let refusals = 0;
    let reauthenticated = false;
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.transport({
          url: `${this.config.baseUrl}${path}`,
          headers: {
            Authorization: `Bearer ${await this.tokens.get()}`,
            'Content-Type': 'application/vnd.api.v1+json',
            Accept: 'application/vnd.api.v1+json',
            'traceability-id': randomUUID(),
            'x-uetr': uetr,
          },
          body,
          timeoutMs: this.config.requestTimeoutMs,
        });
      } catch (error) {
        const cause = error instanceof TransportTimeoutError ? 'timeout' : 'network';
        return { outcome: 'no-answer', cause };
      }

      if (response.status === 401 && !reauthenticated) {
        reauthenticated = true;
        this.tokens.invalidate();
        continue;
      }
      if (
        options.retryRefusals &&
        RETRYABLE_REFUSALS.has(response.status) &&
        refusals < REFUSAL_RETRIES
      ) {
        refusals += 1;
        await this.sleep(500 * 2 ** (refusals - 1));
        continue;
      }
      return { outcome: 'response', status: response.status, body: response.body };
    }
  }

  private async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}

type Resolution =
  | { state: 'SETTLED' | 'PENDING'; clearingSystemReference?: string; unanswered?: boolean }
  | {
      state: 'REJECTED' | 'ERROR';
      reason: PaymentReason;
      unanswered?: undefined;
      clearingSystemReference?: undefined;
    };

function sameInput(a: SendPaymentInput, b: SendPaymentInput): boolean {
  return (
    a.payeeRef === b.payeeRef &&
    a.amountCents === b.amountCents &&
    a.remittanceReference === b.remittanceReference
  );
}
