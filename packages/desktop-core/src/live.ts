import { backoffDelay, DEFAULT_BACKOFF } from "../../sync-core/src/index.ts";
import type { HttpPort, TimerPort } from "./ports.ts";

export type LiveOutcome = { kind: "changed" } | { kind: "quiet" } | { kind: "unauthorized" } | { kind: "update_required" } | { kind: "error" };

/**
 * The live connection of the running desktop app (SYNC_PROTOCOL 14.7): a long poll of
 * `GET /api/sync/wait?since=<cursor>&timeout=25`. The answer is only a HINT ("something changed"),
 * never data: on `changed` the host runs a normal pull. A pull is not started more than once per
 * `minPullGapMs` from here, errors back off with the sync-core backoff (bounded, full jitter), and
 * a dead connection costs freshness only (the engine's own periodic pull still runs).
 */
export class LiveConnection {
  private running = false;
  private failures = 0;
  private lastPullAt = Number.NEGATIVE_INFINITY;
  /** Resolves when the loop has ended (tests). */
  done: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      http: HttpPort;
      timers: TimerPort & { sleep(ms: number): Promise<void> };
      random: { next(): number };
      cursor: () => Promise<number>;
      onHint: () => void;
      onUnauthorized: () => void;
      onUpdateRequired: () => void;
      protocol?: number;
      waitSeconds?: number;
      minPullGapMs?: number;
    },
  ) {}

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.done = this.loop();
  }

  stop(): void {
    this.running = false;
  }

  /** One poll; exported for tests. */
  async pollOnce(): Promise<LiveOutcome> {
    const { http } = this.deps;
    const since = await this.deps.cursor();
    const seconds = this.deps.waitSeconds ?? 25;
    let response;
    try {
      response = await http.request({
        method: "GET",
        path: `/api/sync/wait?since=${since}&timeout=${seconds}`,
        headers: { "Atlas-Sync": String(this.deps.protocol ?? 1) },
        timeoutMs: (seconds + 15) * 1000,
      });
    } catch {
      return { kind: "error" };
    }
    if (response.status === 401) return { kind: "unauthorized" };
    if (response.status === 426) return { kind: "update_required" };
    if (response.status !== 200) return { kind: "error" };
    try {
      const body = JSON.parse(response.body) as { changed?: boolean };
      return body.changed ? { kind: "changed" } : { kind: "quiet" };
    } catch {
      return { kind: "error" };
    }
  }

  private async loop(): Promise<void> {
    const { timers } = this.deps;
    while (this.running) {
      const startedAt = timers.monotonic();
      const outcome = await this.pollOnce();
      if (!this.running) return;
      switch (outcome.kind) {
        case "changed": {
          this.failures = 0;
          const gap = this.deps.minPullGapMs ?? 5_000;
          const wait = this.lastPullAt + gap - timers.monotonic();
          if (wait > 0) await timers.sleep(wait);
          if (!this.running) return;
          this.lastPullAt = timers.monotonic();
          this.deps.onHint();
          break;
        }
        case "quiet": {
          this.failures = 0;
          // a server (or proxy) that answers at once must not turn the long poll into a hot loop
          const elapsed = timers.monotonic() - startedAt;
          if (elapsed < 1_000) await timers.sleep(1_000 - elapsed);
          break;
        }
        case "unauthorized":
          this.running = false;
          this.deps.onUnauthorized();
          return;
        case "update_required":
          this.running = false;
          this.deps.onUpdateRequired();
          return;
        case "error":
          this.failures++;
          await timers.sleep(backoffDelay(this.failures, this.deps.random, DEFAULT_BACKOFF));
          break;
      }
    }
  }
}
