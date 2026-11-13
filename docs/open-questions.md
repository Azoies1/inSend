# Open questions and inputs

Resolved from sandbox documentation, never by assumption. Answers get recorded here with a link
to the page that settles them.

## Inputs needed from Thomas

- [x] Payments Canada developer portal account (2026-11-13)
- [ ] Payments Canada sandbox App keys in `.env` (Goal 2)
- [ ] Zum Rails sandbox access and API credentials; may require a sales call (Goal 3)
- [ ] Confirm or change the default stack: TypeScript, Postgres, SwiftUI. Goal 1 was built on the
      default.
- [ ] Apple Developer account and a physical iPhone for Secure Enclave testing (Goal 5)
- [ ] Ownership shares to use for the co-owner split in seed data (Goal 4)

## Open questions

- Does the Zum Rails sandbox expose RTR, or only bank transfer and Interac?
- Does the Payments Canada sandbox simulate confirmation of payee and the fraud safety score, or
  only the payment messages?
- Which reject reason codes does each sandbox return, and how do they map to user-facing
  messages? `REASON_CODES` in `backend/src/payments/provider.ts` is a provisional internal set
  until this is answered.
- Is the Zum Rails sandbox self-serve or sales-gated? Its documentation says both.

## Raised during Goal 1

- The RTR rail has no merchant webhooks as far as the plan describes (status comes from
  pacs.002 reports and pacs.028 enquiries). The contract suite therefore only requires that an
  adapter rejects a badly signed webhook; applying a valid one is optional per adapter. Confirm
  against the RTR sandbox documentation in Goal 2.
