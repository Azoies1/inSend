import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RTR_SANDBOX_TRIGGERS } from '../../src/payments/adapters/rtr-sim/RTRSimAdapter';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../../src/payments/adapters/rtr-sim/transport';

/**
 * Recorded RTR sandbox responses (test/fixtures/rtr/fixtures.json), made by
 * `npm run record:rtr` against the live sandbox with synthetic data only.
 * The sandbox echoes ids from the request, so those are stored as
 * placeholders and filled from each replayed request.
 */
export type FixtureKind = 'send' | 'status';

export interface Fixture {
  key: string;
  kind: FixtureKind;
  /** Trigger end-to-end id, or "default" for any other value. */
  trigger: string;
  recordedAt: string;
  response: HttpResponse;
}

export interface FixtureFile {
  source: string;
  token: HttpResponse;
  fixtures: Fixture[];
}

export const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/rtr/fixtures.json', import.meta.url),
);

const TRIGGERS = new Set<string>(Object.values(RTR_SANDBOX_TRIGGERS));

export interface MessageIds {
  messageId: string;
  uetr: string;
  endToEndId: string;
}

/** Pulls the ids the sandbox echoes from a pacs.008 or pacs.028 request body. */
export function requestIds(kind: FixtureKind, body: string): MessageIds {
  const json = JSON.parse(body);
  const messageId = json.business_application_header.business_message_identifier;
  if (kind === 'send') {
    const ids =
      json.fi_to_fi_customer_credit_transfer.credit_transfer_transaction_information
        .payment_identification;
    return { messageId, uetr: ids.uetr, endToEndId: ids.end_to_end_identification };
  }
  const tx = json.fi_to_fi_payment_status_request.transaction_information;
  return { messageId, uetr: tx.original_uetr, endToEndId: tx.original_end_to_end_identification };
}

export function triggerOf(endToEndId: string): string {
  return TRIGGERS.has(endToEndId) ? endToEndId : 'default';
}

const PLACEHOLDERS = { messageId: '{{messageId}}', uetr: '{{uetr}}', endToEndId: '{{endToEndId}}' };

export function toTemplate(body: string, ids: MessageIds): string {
  let out = body;
  for (const key of ['uetr', 'messageId', 'endToEndId'] as const) {
    if (ids[key]) out = out.split(ids[key]).join(PLACEHOLDERS[key]);
  }
  return out;
}

export function fromTemplate(body: string, ids: MessageIds): string {
  let out = body;
  for (const key of ['uetr', 'messageId', 'endToEndId'] as const) {
    out = out.split(PLACEHOLDERS[key]).join(ids[key]);
  }
  return out;
}

export function loadFixtures(): FixtureFile {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as FixtureFile;
}

export function kindOf(url: string): FixtureKind | 'token' {
  if (url.endsWith('/payments/status')) return 'status';
  if (url.endsWith('/payments')) return 'send';
  if (url.endsWith('/accesstoken')) return 'token';
  throw new Error(`Replay transport has no fixture for ${url}`);
}

export interface ReplayCall {
  kind: FixtureKind | 'token';
  request: HttpRequest;
}

export interface ReplayOptions {
  /** Lets a test intercept a request (hang it, fail it, override it) before replay. */
  intercept?: (call: ReplayCall, index: number) => Promise<HttpResponse> | HttpResponse | undefined;
}

/** An offline HttpTransport answering from recorded sandbox fixtures. Records every call. */
export function replayTransport(options: ReplayOptions = {}) {
  const file = loadFixtures();
  const calls: ReplayCall[] = [];
  const transport: HttpTransport = async (request) => {
    const kind = kindOf(request.url);
    const call = { kind, request };
    calls.push(call);
    const intercepted = await options.intercept?.(call, calls.length - 1);
    if (intercepted) return intercepted;
    if (kind === 'token') return file.token;
    const ids = requestIds(kind, request.body);
    const trigger = triggerOf(ids.endToEndId);
    const fixture = file.fixtures.find((f) => f.kind === kind && f.trigger === trigger);
    if (!fixture) throw new Error(`No ${kind} fixture recorded for trigger ${trigger}`);
    return { status: fixture.response.status, body: fromTemplate(fixture.response.body, ids) };
  };
  const count = (kind: ReplayCall['kind']) => calls.filter((c) => c.kind === kind).length;
  return { transport, calls, count };
}
