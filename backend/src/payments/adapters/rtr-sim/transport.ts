/**
 * The adapter's only window to the network. Tests swap in a replay transport
 * built from recorded sandbox fixtures; production code uses fetchTransport.
 */
export interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  /** Exact bytes sent. Built as text so amounts never pass through a float. */
  body: string;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

/** No response arrived in time. The request may or may not have been processed. */
export class TransportTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`No response from ${url} within ${timeoutMs} ms`);
    this.name = 'TransportTimeoutError';
  }
}

export const fetchTransport: HttpTransport = async (request) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    if (controller.signal.aborted) throw new TransportTimeoutError(request.url, request.timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
