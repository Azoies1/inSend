# RTR Sandbox

One backend with a single payment interface and swappable sandbox adapters behind it, proven
end to end on a rent payment with an iOS front end.

**Sandbox only.** No production endpoints, no real money, no real personal data.

## Quick start

Requires Node 22.9+ and Docker or Podman (for Postgres). With Podman, run `podman machine start` first.

```bash
npm start
```

That installs dependencies, starts Postgres, applies migrations and starts the API. Then:

```bash
curl http://127.0.0.1:3000/health
```

returns `{"status":"ok","adapter":"fake","db":"up"}`.

No `.env` is needed for the defaults. To change anything, copy `.env.example` to `.env`
(git-ignored) and fill in values.

## Commands

| Command                | What it does                                                  |
| ---------------------- | ------------------------------------------------------------- |
| `npm start`            | Install, start Postgres, migrate, run API                     |
| `npm test`             | Run all backend tests (no database needed)                    |
| `npm run check`        | Format check, lint, typecheck and tests                       |
| `npm run migrate`      | Apply pending migrations                                      |
| `npm run db:up`/`down` | Start or stop the local Postgres container (Docker or Podman) |
| `npm run test:live`    | Live provider sandbox tests (needs `.env` credentials)        |
| `npm run record:rtr`   | Re-record RTR sandbox fixtures (needs `.env` credentials)     |
| `npm run format`       | Format the repo with Prettier                                 |

## Layout

```
backend/
  src/payments/provider.ts      PaymentProvider interface and internal state set
  src/payments/registry.ts      Picks the adapter from PAYMENT_ADAPTER
  src/payments/adapters/fake/   FakeAdapter: settles or rejects on demand
  src/payments/adapters/rtr-sim/ RTRSimAdapter: Payments Canada RTR sandbox (ISO 20022)
  src/config.ts                 Environment config
  src/app.ts, src/server.ts     HTTP API (health endpoint so far)
  migrations/                   SQL migrations
  test/contract/                Shared contract suite every adapter must pass
ios/                            SwiftUI app (Goal 5)
docs/                           Notes, open questions, sponsor documents
```

## The payment interface

Everything outside `backend/src/payments/adapters/` talks to providers only through
`PaymentProvider`: `createPayee`, `sendPayment`, `getStatus`, `handleWebhook`. Every adapter maps
provider outcomes to `PENDING`, `SETTLED`, `REJECTED` (with reason) or `ERROR`. Only `SETTLED` is
final success. A lint rule blocks imports of adapter code from the rest of the backend.

The adapter is chosen by one environment variable, `PAYMENT_ADAPTER`: `fake` (default),
`rtr-sim` (Goal 2) or `zum` (Goal 3).

To add an adapter, write a harness for `backend/test/contract/adapterContract.ts`; the suite
itself does not change.

## Status

| Goal | Scope                               | State       |
| ---- | ----------------------------------- | ----------- |
| 1    | Project skeleton, interface, fake   | Done        |
| 2    | Payments Canada RTR sandbox adapter | Done        |
| 3    | Zum Rails sandbox adapter           | Not started |
| 4    | Ledger and rent flow                | Not started |
| 5    | iOS app                             | Not started |
