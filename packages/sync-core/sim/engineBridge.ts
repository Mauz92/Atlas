import type { HttpRequest, HttpResponse } from "../src/ports.ts";
import type { Req, Resp } from "./model/common.ts";

/** What the simulation needs from a server: the model in memory, or the real API over HTTP. */
export interface ServerPort {
  handle(req: Req): Promise<Resp>;
  head(): Promise<number>;
  allEntityIds(): Promise<string[]>;
}

export function toReq(request: HttpRequest, extraHeaders: Record<string, string> = {}): Req {
  return {
    method: request.method,
    path: request.path,
    params: { ...(request.query ?? {}) },
    body: (request.body as Record<string, unknown> | undefined) ?? null,
    headers: { ...request.headers, ...extraHeaders },
  };
}

export function toResponse(resp: Resp): HttpResponse {
  return { status: resp.status, body: resp.body, headers: {} };
}
