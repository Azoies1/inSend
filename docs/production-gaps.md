# Production gaps

Every place where real identity checks, anti-money-laundering controls, fund holding or a sponsor's
API would plug in, with the file and function that would change. This document is written as the
build progresses.

## Payment rail access (Goal 2)

| Gap                         | Where                                                                   | What changes                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Direct RTR access           | `adapters/rtr-sim/*`                                                    | A non-participant cannot call the RTR. Production reaches it through a sponsor's API, as a new adapter behind `PaymentProvider`.   |
| Message signing (JWS)       | `adapters/rtr-sim/RTRSimAdapter.ts` `post()`                            | Sign each request body with the participant's key (`x-jws-signature`) and verify the response signature. The sandbox ignores both. |
| Durable adapter state       | `adapters/rtr-sim/store.ts` `InMemoryRtrStore`                          | Postgres-backed `RtrStore` with a unique index on the idempotency key, so claims survive restarts and span processes.              |
| Cross-process locking       | `adapters/rtr-sim/RTRSimAdapter.ts` `withLock()`                        | In-process only. Production needs the database claim (above) or an advisory lock.                                                  |
| Debtor identity             | `adapters/rtr-sim/config.ts` `RTR_DEBTOR_*`                             | A fixed synthetic platform account today. Production sends the real payer, verified by identity checks (KYC).                      |
| Payee verification          | `adapters/rtr-sim/RTRSimAdapter.ts` `createPayee()`                     | Format checks only. Production adds confirmation of payee and sanctions screening before a payee can be paid.                      |
| AML / fraud screening       | `adapters/rtr-sim/RTRSimAdapter.ts` `sendPayment()`, before `deliver()` | Transaction monitoring and fraud scoring before sending; the RTR sandbox offers neither.                                           |
| User-facing reject messages | `adapters/rtr-sim/mapping.ts` `REASONS`                                 | Descriptions come from the sandbox's scenario sheet; production wording needs review.                                              |
