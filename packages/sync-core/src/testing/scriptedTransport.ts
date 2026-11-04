import type { HttpRequest, HttpResponse, Transport } from "../ports.ts";

export type ScriptedReply =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { drop: true }
  | ((request: HttpRequest) => ScriptedReply | Promise<ScriptedReply>);

/** A transport for unit tests: replies are queued per `METHOD path-prefix`, requests recorded. */
export class ScriptedTransport implements Transport {
  readonly requests: HttpRequest[] = [];
  private readonly rules: { match: string; replies: ScriptedReply[]; sticky: boolean }[] = [];

  /** `reply("GET /api/changes", r1, r2)`: the replies are used in order; the last one repeats. */
  reply(match: string, ...replies: ScriptedReply[]): this {
    this.rules.unshift({ match, replies, sticky: true }); // the newest rule for a prefix wins
    return this;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(structuredClone(request));
    const label = `${request.method} ${request.path}`;
    const rule = this.rules.find((r) => label.startsWith(r.match));
    if (!rule) throw new Error(`ScriptedTransport: no reply for ${label}`);
    const picked: ScriptedReply = rule.replies.length > 1 ? rule.replies.shift()! : rule.replies[0]!;
    const reply = typeof picked === "function" ? await picked(request) : picked;
    if ("drop" in reply) throw new Error("connection lost");
    if (typeof reply === "function") throw new Error("nested reply functions are not supported");
    return {
      status: reply.status,
      body: reply.body ?? null,
      headers: reply.headers ?? {},
    };
  }
}
