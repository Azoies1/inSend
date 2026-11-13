import type { PaymentReason, ReasonCode } from '../../provider';

/**
 * Maps RTR responses (pacs.002 and admi.002) to the internal state set.
 *
 * Sources, recorded in docs/rtr-notes.md:
 * - RTR Sandbox API Test Scenarios v3.0 (developer.payments.ca), which lists
 *   each reason code the sandbox returns and describes ACSP as "Successful
 *   payment finality".
 * - Live sandbox responses recorded 2026-11-13 (test/fixtures/rtr).
 */

/** Reason codes the sandbox documents, with their internal category and description. */
const REASONS: Record<string, { code: ReasonCode; message: string }> = {
  AB02: { code: 'TECHNICAL_FAILURE', message: 'Technical error at the RTR Exchange' },
  AB03: { code: 'TECHNICAL_FAILURE', message: 'Transaction timed out' },
  AB04: { code: 'SETTLEMENT_FAILED', message: 'Settlement process aborted' },
  AB09: { code: 'TECHNICAL_FAILURE', message: 'Technical error at the receiving institution' },
  AC08: { code: 'INVALID_ACCOUNT', message: 'Branch (transit) code is invalid or missing' },
  AG08: { code: 'NOT_AUTHORIZED', message: 'Not authorised to send this message' },
  AG09: { code: 'UNDELIVERABLE', message: 'The payment was never received by the RTR Exchange' },
  AG10: { code: 'UNDELIVERABLE', message: 'Sending institution is suspended from the RTR' },
  AG11: { code: 'UNDELIVERABLE', message: 'Receiving institution is suspended from the RTR' },
  AM02: { code: 'LIMIT_EXCEEDED', message: 'Amount is greater than the allowed maximum' },
  DS09: { code: 'MALFORMED_MESSAGE', message: 'Message could not be decrypted' },
  DUPL: { code: 'MALFORMED_MESSAGE', message: 'Duplicate of another payment' },
  ED05: { code: 'SETTLEMENT_FAILED', message: 'Settlement failed' },
  FF02: { code: 'MALFORMED_MESSAGE', message: 'Message failed syntax validation' },
  FF05: { code: 'MALFORMED_MESSAGE', message: 'Local instrument code is missing or invalid' },
  RR07: { code: 'RECEIVER_REJECTED', message: 'Rejected by the receiving institution' },
};

export function mapReason(providerCode: string | undefined, detail?: string): PaymentReason {
  const known = providerCode ? REASONS[providerCode] : undefined;
  return {
    code: known?.code ?? 'OTHER',
    message: (detail?.trim() || known?.message) ?? 'Rejected by the RTR',
    ...(providerCode ? { providerCode } : {}),
  };
}

/** A pacs.002 transaction status reduced to what the adapter acts on. */
export type RailStatus =
  | { kind: 'SETTLED' }
  | { kind: 'PENDING' }
  | { kind: 'REJECTED'; reason: PaymentReason }
  | { kind: 'UNKNOWN_CODE'; code: string };

/**
 * ACSP is final success in this sandbox (test scenarios: "Successful payment
 * finality (ACSP)"); ACSC is ISO "settlement completed". PDNG is listed by the
 * sandbox guidelines but no scenario produces it.
 */
export function mapTransactionStatus(
  code: string,
  reasonCode: string | undefined,
  detail: string | undefined,
): RailStatus {
  switch (code) {
    case 'ACSP':
    case 'ACSC':
      return { kind: 'SETTLED' };
    case 'PDNG':
      return { kind: 'PENDING' };
    case 'RJCT':
      return { kind: 'REJECTED', reason: mapReason(reasonCode, detail) };
    default:
      return { kind: 'UNKNOWN_CODE', code };
  }
}

// --- Response parsing -------------------------------------------------------

export interface Pacs002 {
  type: 'pacs.002';
  originalMessageId?: string;
  originalMessageName?: string;
  originalEndToEndId?: string;
  originalUetr?: string;
  transactionStatus?: string;
  reasonCode?: string;
  additionalInformation?: string;
  clearingSystemReference?: string;
}

export interface Admi002 {
  type: 'admi.002';
  relatedReference?: string;
  reasonCode?: string;
  description?: string;
}

export type RtrResponse = Pacs002 | Admi002;

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function field(object: unknown, ...path: string[]): unknown {
  let current = object;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Parses a 200 response body. Returns null if it is neither a pacs.002 nor an admi.002. */
export function parseResponse(body: string): RtrResponse | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const status = field(
    json,
    'fi_to_fi_payment_status_report',
    'transaction_information_and_status',
  );
  if (status && typeof status === 'object') {
    const info = field(status, 'additional_information');
    return {
      type: 'pacs.002',
      originalMessageId: str(
        field(status, 'original_group_information', 'original_message_identification'),
      ),
      originalMessageName: str(
        field(status, 'original_group_information', 'original_message_name_identification'),
      ),
      originalEndToEndId: str(field(status, 'original_end_to_end_identification')),
      originalUetr: str(field(status, 'original_uetr')),
      transactionStatus: str(field(status, 'transaction_status')),
      reasonCode: str(field(status, 'status_reason_information', 'reason', 'code')),
      additionalInformation:
        str(field(status, 'status_reason_information', 'additional_information')) ??
        (Array.isArray(info) ? info.filter((x) => typeof x === 'string').join(' ') : str(info)),
      clearingSystemReference: str(field(status, 'clearing_system_reference')),
    };
  }
  const reject = field(json, 'message_reject');
  if (reject && typeof reject === 'object') {
    return {
      type: 'admi.002',
      relatedReference: str(field(reject, 'related_reference', 'reference')),
      reasonCode: str(field(reject, 'reason', 'rejecting_party_reason')),
      description: str(field(reject, 'reason', 'reason_description')),
    };
  }
  return null;
}

/**
 * Enquiry rejections that describe the enquiry rather than the payment carry no
 * clearing system reference (sandbox returns "NOTAVAILABLE" for AG08 and AG09).
 */
export const NO_CLEARING_REFERENCE = 'NOTAVAILABLE';
