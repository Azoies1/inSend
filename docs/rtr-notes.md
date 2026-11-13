# Payments Canada RTR sandbox: adapter notes

How `RTRSimAdapter` (`backend/src/payments/adapters/rtr-sim/`) talks to the RTR sandbox, what each
message carries, and what the sandbox documentation leaves unclear. Everything below was read
from the sources listed, or observed in the live sandbox on 2026-11-13.

## Sources

- RTR Sandbox API page: https://developer.payments.ca/rtr-sandbox-api/apis
- OpenAPI specs and Postman collection: https://github.com/paymentscanada/api-toolkit (branch
  `develop`): `swagger-oas/RTR-Sandbox/spec-exchange/*.yaml`,
  `postman-collection/RTR-Sandbox/RTR - Payments (External).postman_collection.json`
- RTR Sandbox API Test Scenarios v3.0 (xlsx, linked from the RTR Sandbox API page)
- Live probes against `https://api.payments.ca/rtr-sandbox` with synthetic data

A non-participant never calls the RTR directly in production. This adapter exists to learn the
rail's ISO 20022 message model; the product would reach the RTR through a sponsor or platform
(Goal 3 and later).

## Access

| Item        | Value                                                                       |
| ----------- | --------------------------------------------------------------------------- |
| Portal app  | One App on developer.payments.ca with product `rtr-sandbox-product`         |
| Token       | `POST https://api.payments.ca/accesstoken`, HTTP Basic `key:secret`,        |
|             | body `grant_type=client_credentials&scope=client_credentials`               |
| Token reply | `access_token`, `token_type: Bearer`, `expires_in` as a string (`"1799"` s) |
| Base URL    | `https://api.payments.ca/rtr-sandbox` (config refuses non-sandbox paths)    |
| Env vars    | `RTR_CONSUMER_KEY`, `RTR_CONSUMER_SECRET` (+ optional overrides in config)  |

The token is cached until 60 s before `expires_in` and refreshed once on HTTP 401.

## Messages used

### pacs.008.001.08 FI to FI Customer Credit Transfer (`POST /payments`)

Answered synchronously by **pacs.002.001.10** (payment status) or **admi.002.001.01** (message
reject), both with HTTP 200.

| Field (under `credit_transfer_transaction_information` unless noted) | Populated with                              |
| -------------------------------------------------------------------- | ------------------------------------------- |
| `business_application_header` (from, to, ids, `creation_date`)       | our participant id → `RTR`, message id, now |
| `group_header.message_identification`                                | new 32-hex id (same as header id)           |
| `group_header.number_of_transactions`                                | `"1"`                                       |
| `group_header.settlement_information`                                | `CLRG`, clearing system `RTR`               |
| `payment_identification.end_to_end_identification`                   | remittance reference, or a sandbox trigger  |
| `payment_identification.uetr`                                        | new UUID v4; also our internal payment id   |
| `payment_type_information.local_instrument.proprietary`              | `RTREXCHANGE`                               |
| `interbank_settlement_amount`                                        | `CAD`, amount as an exact 2-decimal number  |
| `interbank_settlement_date`                                          | today (UTC)                                 |
| `charge_bearer`                                                      | `SLEV`                                      |
| `instructing_agent`, `debtor_agent`                                  | `RTR_PARTICIPANT_ID` (sandbox `111`)        |
| `instructed_agent`, `creditor_agent`                                 | payee institution number (sandbox `999`)    |
| `debtor`, `debtor_account`                                           | `RTR_DEBTOR_NAME`, `RTR_DEBTOR_ACCOUNT`     |
| `creditor`, `creditor_account.identification.other.identification`   | payee name, `transit-account`               |
| `remittance_information.unstructured[0]`                             | remittance reference                        |

Every field the schema marks required is sent. Debtor and debtor account are required, so the
adapter sends a configured synthetic platform account.

**Amounts.** The schema wants a JSON number with `multipleOf: 0.01`. The adapter writes the decimal
literal from integer cents as text (`185000` → `1850.00`), so no float is involved. The sandbox
rejects a string amount and three decimals with admi.002 FF02 (observed).

### pacs.028.001.03 FI to FI Payment Status Request (`POST /payments/status`)

Refers to the pacs.008 by `original_message_identification`, `original_end_to_end_identification`
and `original_uetr`, with instructing and instructed agents. Answered by pacs.002 or admi.002.
The pacs.002 to an enquiry echoes the **pacs.028's** message id, so the adapter correlates
enquiry answers by UETR.

### Not used

admi.004/admi.011 heartbeat, camt.003/camt.004 balance and interest reports. They concern a
participant's settlement account, not a payment.

## Outcome mapping

| RTR answer                                        | Internal state | Notes                                    |
| ------------------------------------------------- | -------------- | ---------------------------------------- |
| pacs.002 `ACSP`                                   | SETTLED        | Scenarios: "Successful payment finality" |
| pacs.002 `ACSC`                                   | SETTLED        | ISO: settlement completed                |
| pacs.002 `PDNG`                                   | PENDING        | Listed, but no scenario produces it      |
| pacs.002 `RJCT` + reason                          | REJECTED       | Reason mapped below                      |
| admi.002 to a pacs.008                            | ERROR          | The message never became a payment       |
| HTTP 400/401 (after re-auth)/403/404              | ERROR          | Refused, not processed                   |
| HTTP 429/503 after 2 backoff retries              | ERROR          | Refused, not processed                   |
| Timeout, network failure, other 5xx               | PENDING        | Unconfirmed; resolved only by pacs.028   |
| Enquiry: RJCT `AG09` (never received)             | REJECTED       | No payment exists; safe to start anew    |
| Enquiry: RJCT `AG08`, admi.002, 401/403           | unchanged      | Enquiry failed; error raised             |
| Enquiry: 5xx / timeout                            | unchanged      | Stays PENDING for the next poll          |
| Unknown status code, or answer about another UETR | unchanged      | Not trusted                              |

Reason codes documented by the sandbox and their internal category (`mapping.ts`):

| Code                   | Internal          | Meaning                                   |
| ---------------------- | ----------------- | ----------------------------------------- |
| AB02, AB03, AB09       | TECHNICAL_FAILURE | Exchange error, timeout, receiver error   |
| AB04, ED05             | SETTLEMENT_FAILED | Settlement aborted / failed               |
| AC08                   | INVALID_ACCOUNT   | Branch (transit) code invalid             |
| AG08                   | NOT_AUTHORIZED    | Sender not allowed (CSP eligibility)      |
| AG09, AG10, AG11       | UNDELIVERABLE     | Never received / agent suspended          |
| AM02                   | LIMIT_EXCEEDED    | Over the system maximum                   |
| DS09, DUPL, FF02, FF05 | MALFORMED_MESSAGE | Decryption, duplicate, schema, instrument |
| RR07                   | RECEIVER_REJECTED | Receiving participant rejected            |
| anything else          | OTHER             | Provider code kept for audit              |

## Idempotency and timeouts

The sandbox keeps **no state** (observed): it does not detect a resent identical message, and it
answers an enquiry about a payment it never received with ACSP. So the adapter owns idempotency:

1. `sendPayment` claims a record keyed by the idempotency key **before** sending (UETR, message id
   and end-to-end id are fixed at that moment).
2. Same key with the same details returns that record; with different details, `IdempotencyConflictError`.
3. A pacs.008 that may have been processed (timeout, network failure, 5xx, unreadable or
   mismatched answer) is **never resent**. The adapter sends a pacs.028 enquiry instead. If that
   fails too, the payment stays PENDING and `delivery: unconfirmed`, and the next `getStatus` or
   retried `sendPayment` asks again.
4. Final states are stored and never re-enquired. That matters here because the sandbox would
   answer ACSP for anything.
5. Concurrent calls with one key are serialised in-process.

The store is in-memory (`InMemoryRtrStore`) for this goal; see `production-gaps.md`.

## Sandbox triggers

The sandbox picks an outcome from `end_to_end_identification` alone. Any value not in the list
gets the default, ACSP. To drive a specific outcome, give a synthetic payee one of these values as
its **account number**. The adapter then uses it as the end-to-end id
(`RTR_SANDBOX_TRIGGERS` in `RTRSimAdapter.ts`).

| Value         | Send (pacs.008) | Enquiry (pacs.028) |
| ------------- | --------------- | ------------------ |
| 1234567890112 | RJCT AB04       | RJCT AB04          |
| 1234567890113 | (not used)      | RJCT AG08          |
| 1234567890114 | (not used)      | RJCT AG09          |
| 1234567890116 | RJCT AM02       | (default ACSP)     |
| 1234567897771 | admi.002 FF02   | (default ACSP)     |
| 1234567897772 | admi.002 DS09   | (default ACSP)     |
| 1234567897773 | HTTP 401        | (default ACSP)     |
| 1234567897774 | admi.002 DUPL   | (default ACSP)     |
| 1234567897777 | RJCT AB03       | (default ACSP)     |
| 1234567898885 | (default ACSP)  | HTTP 500           |

Besides the triggers, the sandbox really validates the schema (FF02) and the amount limit: AM02
for 99,999,999.99 (observed).

## Tests and fixtures

- `npm test`: contract suite, four outcomes, timeouts and mapping, offline against
  `backend/test/fixtures/rtr/fixtures.json`.
- `npm run record:rtr`: re-records those fixtures from the live sandbox. Echoed ids are stored
  as `{{uetr}}`, `{{messageId}}` and `{{endToEndId}}` placeholders; token values are never stored.
- `npm run test:live`: the same contract and four outcomes against the live sandbox, including a
  PENDING reached by a real network timeout.

## Unclear in the documentation

1. **Request signing.** The spec marks `x-jws-signature` (JWS of the payload) required on every
   request, and the response is documented to carry one. The sandbox ignores the header and
   returns none, and nothing says which key or certificate signs, or how to verify. The adapter
   sends no signature.
2. **`traceability-id` and `x-uetr` headers** are marked required. The sandbox ignores them, and
   even a header UETR that differs from the body passed, although scenario 16 says that case
   should be an admi.002. The adapter sends both, correctly.
3. **Token lifetime.** The spec says "expires in 5 minutes"; the gateway returns `expires_in: 1799`.
   The adapter trusts `expires_in`.
4. **ACSP vs ACSC.** The scenarios call ACSP "successful payment finality", while ISO defines ACSP
   as "settlement in process". Production may send ACSP then ACSC (or a pacs.002 commit advice).
   Both map to SETTLED for now.
5. **PDNG** is listed as a possible status, but no scenario returns it and nothing says when the
   Exchange would.
6. **Enquiry RJCT semantics.** AG08 and AG09 come back as `RJCT` pacs.002, the same shape as a
   rejected payment. The only distinguishing mark is `clearing_system_reference: "NOTAVAILABLE"`,
   which the adapter relies on.
7. **Duplicate detection** (DUPL) exists only as a trigger; whether production detects duplicates
   by UETR, message id or end-to-end id is not stated.
8. **System maximum** amount (AM02) is not documented; 99,999,999.99 was rejected.
9. **Confirmation of payee and fraud scores** are not in this sandbox at all. No endpoint, field or
   scenario covers them.
10. **Pull payments.** The RTR is credit-push only (pacs.008 from the payer's institution). Rent
    collected from a tenant would be initiated by the tenant's institution, or by a sponsor acting
    for it. The sandbox models the platform as the sender (`debtor` = platform account). This is
    an open product question, recorded in `open-questions.md`.
