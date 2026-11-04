import type { HttpRequest, HttpResponse, Transport } from "../ports.ts";

/** The part of `fetch` the transport needs; the host passes its own (`window.fetch`, Tauri's, ...). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  headers: { forEach(cb: (value: string, key: string) => void): void };
  text(): Promise<string>;
}>;

/**
 * A {@link Transport} over an injected `fetch`. HTTPS only except loopback (SYNC_PROTOCOL 10.1);
 * a rejected fetch (no response) rejects, so the engine retries the identical request.
 */
export function createFetchTransport(options: {
  baseUrl: string;
  fetch: FetchLike;
  allowInsecure?: boolean;
}): Transport {
  const base = options.baseUrl.replace(/\/+$/, "");
  const url = new URL(base);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback && !options.allowInsecure)
    throw new Error("sync requires https (http only for localhost)");
  return {
    async send(request: HttpRequest): Promise<HttpResponse> {
      const query = request.query
        ? "?" + Object.entries(request.query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&")
        : "";
      const headers = { ...request.headers };
      const init: { method: string; headers: Record<string, string>; body?: string } = { method: request.method, headers };
      if (request.body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(request.body);
      }
      const response = await options.fetch(`${base}${request.path}${query}`, init);
      const text = await response.text();
      const out: Record<string, string> = {};
      response.headers.forEach((value, key) => (out[key.toLowerCase()] = value));
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { status: response.status, body, headers: out };
    },
  };
}
