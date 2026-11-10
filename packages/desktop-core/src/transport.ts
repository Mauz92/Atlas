import type { HttpRequest, HttpResponse, Transport } from "../../sync-core/src/index.ts";
import type { HttpPort } from "./ports.ts";

export function queryString(query: HttpRequest["query"]): string {
  if (!query) return "";
  const parts = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * The sync-core {@link Transport} over the platform's {@link HttpPort}. The port attaches the device
 * token and the origin, so no URL and no secret ever pass through this code. A rejected request
 * (no response) rejects here, and the engine retries the identical request.
 */
export function createPortTransport(http: HttpPort, timeoutMs = 30_000): Transport {
  return {
    async send(request: HttpRequest): Promise<HttpResponse> {
      const headers = { ...request.headers };
      delete headers["Authorization"]; // the host owns the token
      const init: { body?: string } = {};
      if (request.body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(request.body);
      }
      const response = await http.request({
        method: request.method,
        path: `${request.path}${queryString(request.query)}`,
        headers,
        timeoutMs,
        ...init,
      });
      let body: unknown = null;
      if (response.body) {
        try {
          body = JSON.parse(response.body);
        } catch {
          body = null;
        }
      }
      return { status: response.status, body, headers: response.headers };
    },
  };
}
