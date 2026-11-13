# RTR Sandbox: rules for working in this repo

Thomas reviews at each goal's acceptance check. If a task cannot be done without breaking a
guardrail, stop and ask.

## Guardrails

- Sandbox only. Never call a production endpoint. Base URLs come from env vars and default to sandbox.
- No real money or personal data. Synthetic names, accounts and amounts everywhere, tests and seeds included.
- No secrets in the repo. Credentials live in the git-ignored `.env`; `.env.example` has empty values.
- Do not invent API shapes. Read the provider's sandbox docs before writing an adapter; record
  anything unclear in `docs/open-questions.md` instead of guessing.
- Provider logic stays inside `backend/src/payments/adapters/<name>/`. Nothing else imports
  provider types, URLs or status codes (lint enforces this).
- Money is integer cents (`Cents` in `backend/src/money.ts`). No floats. Currency is CAD.
- Every payment call is idempotent. On a timeout, query status; never resend.
- The ledger is append-only. Corrections are reversing entries, never edits or deletes.
- Tests accompany every goal. A goal is done only when its acceptance check is green from a clean checkout.

## Commands

- `npm run check`: format check, lint, typecheck, tests. Run before calling anything done.
- `npm test`: tests only. They need no database or network.
- `npm start`: install, Postgres via Docker or Podman, migrate, run the API.
- `npm run test:live`: live provider sandbox tests (credentials in `.env`). Not part of CI.
- `npm run record:rtr`: re-record RTR fixtures from the live sandbox. Synthetic data only.

## Conventions

- A new adapter gets a harness for `backend/test/contract/adapterContract.ts`. Do not edit the
  suite to make an adapter pass.
- Adapters map provider reason codes onto `REASON_CODES` in `payments/provider.ts`.
- Recorded provider fixtures must contain synthetic data only.
