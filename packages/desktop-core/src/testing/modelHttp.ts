import type { Req } from "../../../sync-core/sim/model/common.ts";
import { ModelServer } from "../../../sync-core/sim/model/server.ts";
import type { HttpPort, HttpPortRequest, HttpPortResponse } from "../ports.ts";

/** An {@link HttpPort} answered by the simulation's model of the server (no network, deterministic). */
export function modelHttp(server: ModelServer, hooks: { before?: (req: HttpPortRequest) => HttpPortResponse | null } = {}): HttpPort & { count: number } {
  const port = {
    count: 0,
    async request(req: HttpPortRequest): Promise<HttpPortResponse> {
      port.count++;
      const early = hooks.before?.(req);
      if (early) return early;
      const url = new URL(req.path, "http://model.invalid");
      const params: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (params[k] = v));
      const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : null;
      const request: Req = { method: req.method, path: url.pathname, params, body, headers: { ...req.headers } };
      const resp = await server.handle(request);
      return { status: resp.status, headers: {}, body: resp.body === null || resp.body === undefined ? "" : JSON.stringify(resp.body) };
    },
  };
  return port;
}
