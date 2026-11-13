/**
 * Records RTR sandbox responses into test/fixtures/rtr/fixtures.json.
 * Usage (needs RTR_CONSUMER_KEY/SECRET in the repo .env): npm run record:rtr
 *
 * Sends only synthetic data, built by the adapter's own message builders, to
 * the sandbox base URL (the config refuses anything else). Response ids that
 * echo the request are templated; token values are never written.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadEnvFile } from '../../src/loadEnv';
import { cents } from '../../src/money';
import { TokenProvider } from '../../src/payments/adapters/rtr-sim/auth';
import { loadRtrConfig } from '../../src/payments/adapters/rtr-sim/config';
import {
  buildCreditTransfer,
  buildStatusRequest,
  newMessageId,
} from '../../src/payments/adapters/rtr-sim/iso';
import { RTR_SANDBOX_TRIGGERS as T } from '../../src/payments/adapters/rtr-sim/RTRSimAdapter';
import { fetchTransport } from '../../src/payments/adapters/rtr-sim/transport';
import {
  FIXTURE_PATH,
  requestIds,
  toTemplate,
  triggerOf,
  type Fixture,
  type FixtureFile,
  type FixtureKind,
} from './fixtures';

loadEnvFile();
const config = loadRtrConfig(process.env);
const tokens = new TokenProvider({
  ...config,
  transport: fetchTransport,
  timeoutMs: config.requestTimeoutMs,
});

const SEND: string[] = [
  'RENT-FIXTURE-DEFAULT',
  T.REJECTED_SETTLEMENT_ABORTED,
  T.REJECTED_LIMIT,
  T.REJECTED_TIMEOUT,
  T.MESSAGE_ERROR_SCHEMA,
  T.MESSAGE_ERROR_DECRYPTION,
  T.MESSAGE_ERROR_DUPLICATE,
  T.UNAUTHORISED_SIGNER,
];
const STATUS: string[] = [
  'RENT-FIXTURE-DEFAULT',
  T.REJECTED_SETTLEMENT_ABORTED,
  T.ENQUIRY_NOT_AUTHORISED,
  T.ENQUIRY_NEVER_RECEIVED,
  T.ENQUIRY_SERVER_ERROR,
];

async function call(kind: FixtureKind, body: string) {
  const response = await fetchTransport({
    url: `${config.baseUrl}${kind === 'send' ? '/payments' : '/payments/status'}`,
    headers: {
      Authorization: `Bearer ${await tokens.get()}`,
      'Content-Type': 'application/vnd.api.v1+json',
      Accept: 'application/vnd.api.v1+json',
      'traceability-id': randomUUID(),
    },
    body,
    timeoutMs: config.requestTimeoutMs,
  });
  const ids = requestIds(kind, body);
  const fixture: Fixture = {
    key: `${kind}:${triggerOf(ids.endToEndId)}`,
    kind,
    trigger: triggerOf(ids.endToEndId),
    recordedAt: new Date().toISOString(),
    response: { status: response.status, body: toTemplate(response.body, ids) },
  };
  console.log(`${fixture.key.padEnd(24)} HTTP ${response.status}`);
  return fixture;
}

const fixtures: Fixture[] = [];
for (const endToEndId of SEND) {
  const body = buildCreditTransfer({
    messageId: newMessageId(),
    uetr: randomUUID(),
    endToEndId,
    amount: cents(185000),
    createdAt: new Date(),
    participantId: config.participantId,
    debtorName: config.debtorName,
    debtorAccount: config.debtorAccount,
    creditorInstitution: '999',
    creditorName: 'Synthetic Landlord One',
    creditorAccount: '00000-0000002',
    remittance: 'RENT-FIXTURE',
  });
  fixtures.push(await call('send', body));
}
for (const endToEndId of STATUS) {
  const body = buildStatusRequest({
    messageId: newMessageId(),
    createdAt: new Date(),
    participantId: config.participantId,
    creditorInstitution: '999',
    original: { messageId: newMessageId(), endToEndId, uetr: randomUUID() },
  });
  fixtures.push(await call('status', body));
}

const file: FixtureFile = {
  source: `${config.baseUrl} (Payments Canada RTR sandbox), synthetic data only`,
  // Shape of the real token response; values replaced so no credential is stored.
  token: {
    status: 200,
    body: JSON.stringify({
      access_token: 'fixture-token',
      token_type: 'Bearer',
      expires_in: '1799',
    }),
  },
  fixtures,
};
mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
writeFileSync(FIXTURE_PATH, `${JSON.stringify(file, null, 2)}\n`);
console.log(`Wrote ${fixtures.length} fixtures to ${FIXTURE_PATH}`);
