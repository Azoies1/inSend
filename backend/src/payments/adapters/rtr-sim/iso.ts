import { randomUUID } from 'node:crypto';
import { assertPayableAmount, type Cents } from '../../../money';

/**
 * ISO 20022 JSON messages for the Payments Canada RTR sandbox. Field names and
 * nesting follow the official OpenAPI specs (swagger-oas/RTR-Sandbox/spec-exchange
 * in paymentscanada/api-toolkit) and the Postman collection's sample bodies.
 * Only fields the schema marks required, plus remittance information, are sent.
 */

export const PACS_008 = 'pacs.008.001.08';
export const PACS_028 = 'pacs.028.001.03';
export const RTR_LOCAL_INSTRUMENT = 'RTREXCHANGE';

/** Maximum length of ISO Max35Text fields (message ids, end-to-end id). */
export const MAX35 = 35;

/** Placeholder swapped for the decimal literal after JSON.stringify. */
const AMOUNT_SENTINEL = '__RTR_AMOUNT_LITERAL__';

/**
 * Integer cents to the exact decimal literal the schema wants (`multipleOf:
 * 0.01`, JSON number). Pure string arithmetic: 185000 -> "1850.00".
 */
export function centsToDecimalLiteral(amount: Cents): string {
  assertPayableAmount(amount);
  const digits = String(amount).padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** Serialises a message, writing the amount as a raw JSON number literal. */
export function serialise(message: unknown, amount?: Cents): string {
  const text = JSON.stringify(message);
  if (amount === undefined) return text;
  const quoted = JSON.stringify(AMOUNT_SENTINEL);
  if (text.split(quoted).length !== 2)
    throw new Error('Amount placeholder must appear exactly once');
  return text.replace(quoted, centsToDecimalLiteral(amount));
}

/** 32 hex chars: unique, within Max35Text. Same shape the Postman collection uses. */
export function newMessageId(): string {
  return randomUUID().replaceAll('-', '');
}

const member = (id: string) => ({
  financial_institution_identification: {
    clearing_system_member_identification: { member_identification: id },
  },
});

function header(from: string, messageId: string, definition: string, createdAt: string) {
  return {
    from: { financial_institution_identification: member(from) },
    to: {
      organisation_identification: {
        identification: { organisation_identification: { other: { identification: 'RTR' } } },
      },
    },
    business_message_identifier: messageId,
    message_definition_identifier: definition,
    creation_date: createdAt,
  };
}

export interface CreditTransferParams {
  messageId: string;
  uetr: string;
  endToEndId: string;
  amount: Cents;
  createdAt: Date;
  /** Our participant id: instructing agent and debtor agent. */
  participantId: string;
  debtorName: string;
  debtorAccount: string;
  /** Creditor's institution: instructed agent and creditor agent. */
  creditorInstitution: string;
  creditorName: string;
  creditorAccount: string;
  remittance: string;
}

/** pacs.008 FI to FI Customer Credit Transfer. Returns the exact request body text. */
export function buildCreditTransfer(p: CreditTransferParams): string {
  const created = p.createdAt.toISOString();
  const message = {
    business_application_header: header(p.participantId, p.messageId, PACS_008, created),
    fi_to_fi_customer_credit_transfer: {
      group_header: {
        message_identification: p.messageId,
        creation_date_time: created,
        number_of_transactions: '1',
        settlement_information: { settlement_method: 'CLRG', clearing_system: { code: 'RTR' } },
      },
      credit_transfer_transaction_information: {
        payment_identification: { end_to_end_identification: p.endToEndId, uetr: p.uetr },
        payment_type_information: { local_instrument: { proprietary: RTR_LOCAL_INSTRUMENT } },
        interbank_settlement_amount: { currency: 'CAD', amount: AMOUNT_SENTINEL },
        interbank_settlement_date: created.slice(0, 10),
        charge_bearer: 'SLEV',
        instructing_agent: member(p.participantId),
        instructed_agent: member(p.creditorInstitution),
        debtor: { name: p.debtorName },
        debtor_account: { identification: { other: { identification: p.debtorAccount } } },
        debtor_agent: member(p.participantId),
        creditor_agent: member(p.creditorInstitution),
        creditor: { name: p.creditorName },
        creditor_account: { identification: { other: { identification: p.creditorAccount } } },
        remittance_information: { unstructured: [p.remittance] },
      },
    },
  };
  return serialise(message, p.amount);
}

export interface StatusRequestParams {
  messageId: string;
  createdAt: Date;
  participantId: string;
  creditorInstitution: string;
  original: { messageId: string; endToEndId: string; uetr: string };
}

/** pacs.028 FI to FI Payment Status Request about a pacs.008 we sent. */
export function buildStatusRequest(p: StatusRequestParams): string {
  const created = p.createdAt.toISOString();
  return serialise({
    business_application_header: header(p.participantId, p.messageId, PACS_028, created),
    fi_to_fi_payment_status_request: {
      group_header: { message_identification: p.messageId, creation_date_time: created },
      transaction_information: {
        original_group_information: {
          original_message_identification: p.original.messageId,
          original_message_name_identification: PACS_008,
        },
        original_end_to_end_identification: p.original.endToEndId,
        original_uetr: p.original.uetr,
        instructing_agent: member(p.participantId),
        instructed_agent: member(p.creditorInstitution),
      },
    },
  });
}
