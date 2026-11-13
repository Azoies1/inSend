# Open questions and inputs

Resolved from sandbox documentation, never by assumption. Answers get recorded here with a link
to the page that settles them.

## Inputs needed from Thomas

- [x] Payments Canada developer portal account (2026-11-13)
- [x] Payments Canada sandbox App keys in `.env` (2026-11-13)
- [ ] Zum Rails sandbox access and API credentials; may require a sales call (Goal 3)
- [ ] Confirm or change the default stack: TypeScript, Postgres, SwiftUI. Goal 1 was built on the
      default.
- [ ] Apple Developer account and a physical iPhone for Secure Enclave testing (Goal 5)
- [ ] Ownership shares to use for the co-owner split in seed data (Goal 4)

## Open questions

- Does the Zum Rails sandbox expose RTR, or only bank transfer and Interac?
- ~~Does the Payments Canada sandbox simulate confirmation of payee and the fraud safety score, or
  only the payment messages?~~ Only the payment messages (pacs.008/028/002, admi.002/004/011,
  camt.003/004). See `rtr-notes.md`.
- Which reject reason codes does each sandbox return, and how do they map to user-facing
  messages? RTR: answered in `rtr-notes.md` (16 codes, mapped in `rtr-sim/mapping.ts`); the
  user-facing wording still needs a decision. Zum: open. `REASON_CODES` in
  `backend/src/payments/provider.ts` stays provisional until Zum is mapped too.
- Is the Zum Rails sandbox self-serve or sales-gated? Its documentation says both.

## Raised during Goal 2

- **Who sends the rent payment?** The RTR is credit-push only: the payer's institution sends the
  pacs.008. The sandbox adapter acts as the sender from a synthetic platform account. In
  production, either the tenant's bank pushes (with a request-to-pay or similar prompt), or a
  sponsor collects into an account and the platform pays out. This shapes `money-flow.md` in
  Goal 4 and needs Thomas's decision.
- The RTR documentation questions (signing, ACSP vs ACSC, PDNG, enquiry RJCT semantics, the AM02
  maximum) are listed at the end of `rtr-notes.md`.

## Raised during Goal 1

- Confirmed in Goal 2: the RTR sandbox sends no webhooks. RTRSimAdapter refuses every webhook
  (`UNSUPPORTED`). Original note: the RTR rail has no merchant webhooks as far as the plan describes (status comes from
  pacs.002 reports and pacs.028 enquiries). The contract suite therefore only requires that an
  adapter rejects a badly signed webhook; applying a valid one is optional per adapter. Confirm
  against the RTR sandbox documentation in Goal 2.

## Resolved

- **Is the portal's `payments-rail-sandbox` product useful?** No (checked 2026-11-13). Its page,
  https://developer.payments.ca/payments-rail-api/apis, is not linked from the API catalogue,
  publishes no endpoints or spec, and calls itself "illustrative" and "subject to change". The
  RTR Sandbox API (`rtr-sandbox-product`) is the documented one: public OpenAPI specs and a
  Postman collection live in https://github.com/paymentscanada/api-toolkit (branch `develop`,
  folders `swagger-oas/RTR-Sandbox` and `postman-collection/RTR-Sandbox`).
