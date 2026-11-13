import type { HttpTransport } from './transport';

/** Refresh this long before the token's stated expiry. */
const EXPIRY_MARGIN_MS = 60_000;

export class RtrAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RtrAuthError';
  }
}

export interface TokenProviderOptions {
  tokenUrl: string;
  consumerKey: string;
  consumerSecret: string;
  transport: HttpTransport;
  timeoutMs: number;
  now?: () => number;
}

/**
 * OAuth 2 client-credentials token for the Payments Canada API gateway.
 * Request shape from the official Postman collection: POST /accesstoken with
 * HTTP Basic (consumer key:secret) and grant_type=client_credentials. Tokens
 * are cached until shortly before `expires_in`; concurrent callers share one
 * in-flight request.
 */
export class TokenProvider {
  private token: { value: string; expiresAt: number } | undefined;
  private inFlight: Promise<string> | undefined;
  private readonly now: () => number;

  constructor(private readonly options: TokenProviderOptions) {
    this.now = options.now ?? Date.now;
  }

  async get(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt) return this.token.value;
    this.inFlight ??= this.fetchToken().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** Drop the cached token, e.g. after the gateway answers 401. */
  invalidate(): void {
    this.token = undefined;
  }

  private async fetchToken(): Promise<string> {
    const { consumerKey, consumerSecret, tokenUrl, transport, timeoutMs } = this.options;
    const basic = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const response = await transport({
      url: tokenUrl,
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials&scope=client_credentials',
      timeoutMs,
    });
    if (response.status !== 200) {
      throw new RtrAuthError(`Token request failed with HTTP ${response.status}`);
    }
    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new RtrAuthError('Token response was not JSON');
    }
    const value = parsed.access_token;
    // The gateway returns expires_in as a string of seconds (observed "1799").
    const seconds = Number(parsed.expires_in);
    if (typeof value !== 'string' || !value || !Number.isFinite(seconds) || seconds <= 0) {
      throw new RtrAuthError('Token response is missing access_token or expires_in');
    }
    this.token = {
      value,
      expiresAt: this.now() + Math.max(0, seconds * 1000 - EXPIRY_MARGIN_MS),
    };
    return value;
  }
}
