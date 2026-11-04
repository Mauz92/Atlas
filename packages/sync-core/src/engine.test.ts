import { SyncEngine, type EngineOptions } from "./engine.ts";
import { fixedClock, seededRandom, sequenceIds, silentLogger } from "./testing/fakes.ts";
import { MemoryStore } from "./testing/memoryStore.ts";
import { ScriptedTransport } from "./testing/scriptedTransport.ts";
import type { Halt } from "./status.ts";

const EMPTY_PAGE = { changes: [], since: 0, next_since: 0, has_more: false, resync_required: false, resync_reason: null };
const INSTANCE = { status: 200, body: { sync: { epoch: "e1" } } };
const page = (over: Record<string, unknown>) => ({ status: 200, body: { ...EMPTY_PAGE, ...over } });
const taskData = (id: string, revision: number, title: string, extra: Record<string, unknown> = {}) => ({
  id, revision, title, description: null, priority: "none", deleted_at: null, field_revisions: { title: revision, priority: 1 }, ...extra,
});

function setup(options: Partial<EngineOptions> = {}, transport = new ScriptedTransport(), store = new MemoryStore()) {
  const clock = fixedClock();
  const engine = new SyncEngine({
    store, transport, clock, ids: sequenceIds(1), random: seededRandom(2), logger: silentLogger,
    credentials: { getToken: () => "atd_secret" },
    options: { pullIntervalMs: 1000, pullJitterMs: 0, resyncMinIntervalMs: 0, ...options },
  });
  transport.reply("GET /api/instance", INSTANCE);
  return { engine, transport, store, clock };
}

/** Tick until `done()`; time moves 10 ms per round so backoff can elapse. */
async function drive(engine: SyncEngine, clock: ReturnType<typeof fixedClock>, rounds = 60) {
  for (let i = 0; i < rounds; i++) {
    await engine.tick();
    await engine.settled();
    clock.advance(10);
  }
}

/** Like drive, but does not wait for an unanswered request. */
async function pump(engine: SyncEngine, clock: ReturnType<typeof fixedClock>, rounds: number) {
  for (let i = 0; i < rounds; i++) {
    await engine.tick();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    clock.advance(10);
  }
}

const writes = (t: ScriptedTransport) => t.requests.filter((r) => r.method !== "GET");

describe("requests", () => {
  it("sends the sync header, the bearer token, the epoch and one idempotency key per write", async () => {
    const { engine, transport, clock } = setup();
    transport.reply("GET /api/changes", page({}));
    transport.reply("POST /api/tasks", { status: 201, body: taskData("x", 1, "T") });
    const id = await engine.createEntity("task", { title: "T" });
    await drive(engine, clock, 8);
    const post = writes(transport)[0]!;
    expect(post.path).toBe("/api/tasks");
    expect(post.body).toEqual({ id, title: "T" });
    expect(post.headers["Atlas-Sync"]).toBe("1");
    expect(post.headers["Authorization"]).toBe("Bearer atd_secret");
    expect(post.headers["Atlas-Epoch"]).toBe("e1");
    expect(post.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("retries a lost request byte-identically with the same key", async () => {
    const { engine, transport, clock } = setup({ requestTimeoutMs: 50 });
    transport.reply("GET /api/changes", page({}));
    transport.reply("POST /api/tasks", { drop: true }, { status: 201, body: taskData("x", 1, "T") });
    await engine.createEntity("task", { title: "T" });
    await drive(engine, clock, 200);
    const posts = writes(transport);
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts[1]).toEqual(posts[0]);
    expect((await engine.getStatus()).pending).toBe(0);
  });

  it("honours Retry-After on 429 and backs off on 5xx, then retries the same request", async () => {
    const { engine, transport, clock } = setup();
    transport.reply("GET /api/changes", page({}));
    transport.reply(
      "POST /api/tasks",
      { status: 429, headers: { "retry-after": "2" } },
      { status: 503 },
      { status: 201, body: taskData("x", 1, "T") },
    );
    await engine.createEntity("task", { title: "T" });
    await drive(engine, clock, 20);
    expect(writes(transport)).toHaveLength(1); // still waiting for Retry-After (2000 ms)
    expect((await engine.getStatus()).state).toBe("backoff");
    await drive(engine, clock, 600);
    const posts = writes(transport);
    expect(new Set(posts.map((p) => p.headers["Idempotency-Key"])).size).toBe(1);
    expect((await engine.getStatus()).pending).toBe(0);
  });
});

describe("fail-safe states", () => {
  async function halted(status: number, body: unknown) {
    const ctx = setup();
    ctx.transport.reply("GET /api/changes", { status, body });
    await drive(ctx.engine, ctx.clock, 6);
    return ctx;
  }

  it("426 stops syncing, sends nothing more, keeps the queue and survives a restart", async () => {
    const { engine, transport, store, clock } = await halted(426, { error: "sync_version_unsupported", min: 2, max: 3 });
    await engine.createEntity("task", { title: "kept" });
    const before = transport.requests.length;
    await drive(engine, clock, 30);
    expect(transport.requests.length).toBe(before);
    const status = await engine.getStatus();
    expect(status.state).toBe("update_required");
    expect(status.halt).toEqual({ kind: "update_required", min: 2, max: 3 });
    expect(status.pending).toBe(1);
    const again = new SyncEngine({ store, transport, clock, ids: sequenceIds(3), random: seededRandom(4) });
    await again.tick();
    expect(transport.requests.length).toBe(before);
  });

  it("401 means signed out (revoked) and resumes only when told", async () => {
    const { engine, transport, clock } = await halted(401, { error: "token_revoked" });
    expect((await engine.getStatus()).halt).toEqual({ kind: "signed_out", code: "token_revoked" });
    const before = transport.requests.length;
    await drive(engine, clock, 10);
    expect(transport.requests.length).toBe(before);
    transport.reply("GET /api/changes", page({}));
    await engine.resumeAfterSignIn();
    await drive(engine, clock, 10);
    expect(transport.requests.length).toBeGreaterThan(before);
  });

  it("409 epoch_mismatch is a state that waits for the person, not an automatic resync", async () => {
    const { engine, transport, clock } = await halted(409, { error: "epoch_mismatch", epoch: "e2" });
    const status = await engine.getStatus();
    expect(status.state).toBe("restore_confirmation");
    expect(status.halt).toEqual({ kind: "restore_confirmation", reason: "epoch_mismatch", epoch: "e2", head: null });
    const before = transport.requests.length;
    await drive(engine, clock, 10);
    expect(transport.requests.length).toBe(before);
  });

  it("cursor_ahead is surfaced as a restore confirmation too", async () => {
    const { engine } = await halted(200, { ...EMPTY_PAGE, resync_required: true, resync_reason: "cursor_ahead", next_since: 7 });
    const halt = (await engine.getStatus()).halt as Halt;
    expect(halt).toEqual({ kind: "restore_confirmation", reason: "cursor_ahead", epoch: null, head: 7 });
  });
});

describe("pull", () => {
  it("applies a page and the cursor in one transaction: a crash re-delivers the page", async () => {
    const { engine, transport, store, clock } = setup({ backoff: { baseMs: 20, factor: 2, capMs: 40 } });
    transport.reply("GET /api/changes", page({
      changes: [{ entity_type: "task", entity_id: "t1", operation: "upsert", cursor: 1, revision: 1, data: taskData("t1", 1, "A") }],
      next_since: 1,
    }));
    let writeTransactions = 0;
    store.crashBeforeCommit = () => ++writeTransactions === 2; // 1: the epoch, 2: the page and its cursor
    await drive(engine, clock, 40);
    const cursors = transport.requests.filter((r) => r.path === "/api/changes").map((r) => r.query!["since"]);
    expect(cursors[0]).toBe(0);
    expect(cursors[1]).toBe(0); // the lost page was asked for again, not skipped
    expect((await engine.getStatus()).cursor).toBe(1);
    expect((await engine.views()).map((v) => v.fields["title"])).toEqual(["A"]);
  });

  it("pages with the cursor and asks for exactly the types it understands", async () => {
    const { engine, transport, clock } = setup({ pageSize: 2 });
    const row = (n: number) => ({ entity_type: "task", entity_id: `t${n}`, operation: "upsert", cursor: n, revision: 1, data: taskData(`t${n}`, 1, `T${n}`) });
    transport.reply("GET /api/changes",
      page({ changes: [row(1), row(2)], next_since: 2, has_more: true }),
      page({ changes: [row(3)], since: 2, next_since: 3 }));
    await drive(engine, clock, 20);
    const feed = transport.requests.filter((r) => r.path === "/api/changes");
    expect(feed[0]!.query).toMatchObject({ since: 0, limit: 2, include: "data", types: "task,project,note,resolution" });
    expect(feed[1]!.query!["since"]).toBe(2);
    expect((await engine.views()).length).toBe(3);
  });

  it("below_floor walks a snapshot with snapshot=true, keeps entities with pending edits, tombstones the rest", async () => {
    const { engine, transport, clock } = setup({ pageSize: 1 });
    const row = (n: number, rev = 1) => ({ entity_type: "task", entity_id: `t${n}`, operation: "upsert", cursor: n, revision: rev, data: taskData(`t${n}`, rev, `T${n}`) });
    transport.reply("GET /api/changes", page({ changes: [row(1), row(2), row(3)], next_since: 3 }));
    await drive(engine, clock, 10);
    await engine.updateEntity("task", "t2", { title: "mine" }); // pending edit on t2
    transport.reply("GET /api/changes",
      page({ resync_required: true, resync_reason: "below_floor", next_since: 9 }),
      page({ changes: [row(1, 4)], next_since: 4, has_more: true }),
      page({ changes: [], since: 4, next_since: 9 }));
    engine.requestPull();
    await drive(engine, clock, 30);
    const feed = transport.requests.filter((r) => r.path === "/api/changes");
    const walk = feed.filter((r) => r.query!["since"] === 4);
    expect(walk[0]!.query!["snapshot"]).toBe(true);
    const views = new Map((await engine.views()).map((v) => [v.id, v]));
    expect(views.get("t1")!.serverRevision).toBe(4);
    expect(views.get("t2")!.deleted).toBe(false); // pending edit: the edit will bring it back
    expect(views.get("t3")!.deleted).toBe(true); // deleted while away
    expect((await engine.getStatus()).cursor).toBe(9);
  });
});

describe("local edits", () => {
  it("coalesces edits into one patch that keeps the first base, and cancels create+delete", async () => {
    const { engine, store } = setup();
    await store.transaction(async (tx) => {
      await tx.putEntity({ id: "t1", type: "task", server: { revision: 4, fields: { title: "a" }, fieldRevisions: { title: 4 }, content: null, contentHash: null }, deleted: false, deletedRevision: null, refetch: false });
    });
    await engine.updateEntity("task", "t1", { title: "b" });
    await engine.updateEntity("task", "t1", { priority: "high" });
    const queue = await store.transaction(async (tx) => tx.listQueue());
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ action: "patch", fields: { title: "b", priority: "high" }, userBase: 4 });
    const id = await engine.createEntity("task", { title: "x" });
    await engine.deleteEntity("task", id);
    expect((await store.transaction(async (tx) => tx.listQueue())).filter((o) => o.entityId === id)).toHaveLength(0);
  });

  it("chains the base: the second edit continues from what the first one produced", async () => {
    const { engine, transport, store, clock } = setup();
    transport.reply("GET /api/changes", page({}));
    await store.transaction(async (tx) => {
      await tx.putEntity({ id: "t1", type: "task", server: { revision: 4, fields: { title: "a" }, fieldRevisions: { title: 4 }, content: null, contentHash: null }, deleted: false, deletedRevision: null, refetch: false });
    });
    transport.reply("PATCH /api/tasks/t1", { status: 200, body: taskData("t1", 5, "b") }, { status: 200, body: taskData("t1", 6, "c") });
    await engine.updateEntity("task", "t1", { title: "b" });
    await drive(engine, clock, 4); // first patch in flight / acked
    await engine.updateEntity("task", "t1", { title: "c" });
    await drive(engine, clock, 20);
    const patches = writes(transport).filter((r) => r.method === "PATCH");
    expect(patches.map((p) => (p.body as Record<string, unknown>)["base_revision"])).toEqual([4, 5]);
  });

  it("a refused text conflict keeps both versions as data", async () => {
    const { engine, transport, store, clock } = setup();
    transport.reply("GET /api/changes", page({}));
    await store.transaction(async (tx) => {
      await tx.putEntity({ id: "t1", type: "task", server: { revision: 2, fields: { title: "a" }, fieldRevisions: { title: 2 }, content: null, contentHash: null }, deleted: false, deletedRevision: null, refetch: false });
    });
    transport.reply("PATCH /api/tasks/t1", { status: 409, body: { error: "conflict", conflicts: [{ field: "title", reason: "text_conflict", server_revision: 3, server_value: "theirs" }] } });
    await engine.updateEntity("task", "t1", { title: "mine" });
    await drive(engine, clock, 10);
    const [problem] = await engine.problems();
    expect(problem).toMatchObject({ kind: "conflict", code: "conflict" });
    expect(problem!.conflicts).toEqual([{ field: "title", reason: "text_conflict", serverRevision: 3, theirs: "theirs", mine: "mine" }]);
    const status = await engine.getStatus();
    expect([status.pending, status.conflicts, status.failed]).toEqual([0, 1, 0]);
  });

  it("a permanent refusal is a failed problem and does not block later work", async () => {
    const { engine, transport, clock } = setup();
    transport.reply("GET /api/changes", page({}));
    transport.reply("POST /api/tasks", { status: 422, body: { detail: "bad" } }, { status: 201, body: taskData("x", 1, "ok") });
    await engine.createEntity("task", { title: "" });
    await engine.createEntity("task", { title: "ok" });
    await drive(engine, clock, 20);
    const status = await engine.getStatus();
    expect([status.pending, status.failed]).toEqual([0, 1]);
  });
});

describe("notes", () => {
  const note = (revision: number, content: string, hash: string) => ({
    id: "n1", path: "a.md", revision, content, content_hash: hash, size_bytes: content.length, sync: { revision, resolution: [], conflicts: [], merged: false },
  });

  it("rebases text typed while a save was in flight onto the merged answer", async () => {
    const { engine, transport, store, clock } = setup();
    transport.reply("GET /api/changes", page({}));
    await store.transaction(async (tx) => {
      await tx.putEntity({ id: "n1", type: "note", server: { revision: 1, fields: { path: "a.md" }, fieldRevisions: {}, content: "1\n2\n3\n4\n", contentHash: "h1" }, deleted: false, deletedRevision: null, refetch: false });
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    transport.reply("PUT /api/notes/n1", async () => {
      await gate;
      return { status: 200, body: note(3, "x\n1\n2\n3\n4\nSAVED\n", "h3") }; // the server merged another device's line
    }, { status: 200, body: note(4, "x\n1\n2\n3\n4\ny\n", "h4") });
    await engine.editNote("n1", "1\n2\n3\n4\nSAVED\n");
    await pump(engine, clock, 6); // pulled, frozen and sent
    await engine.editNote("n1", "1\n2\n3\n4\nSAVED\nTYPED\n"); // typed while in flight
    release();
    await drive(engine, clock, 20);
    const puts = writes(transport).filter((r) => r.method === "PUT").map((r) => r.body as Record<string, unknown>);
    expect(puts[0]).toMatchObject({ content: "1\n2\n3\n4\nSAVED\n", base_revision: 1, base_hash: "h1" });
    expect(puts[1]).toMatchObject({ base_revision: 3, base_hash: "h3" });
    expect(puts[1]!["content"]).toBe("x\n1\n2\n3\n4\nSAVED\nTYPED\n");
  });

  it("keeps a rejected save's text and the conflict copy as data", async () => {
    const { engine, transport, store, clock } = setup();
    transport.reply("GET /api/changes", page({}));
    await store.transaction(async (tx) => {
      await tx.putEntity({ id: "n1", type: "note", server: { revision: 1, fields: { path: "a.md" }, fieldRevisions: {}, content: "a\n", contentHash: "h1" }, deleted: false, deletedRevision: null, refetch: false });
    });
    transport.reply("PUT /api/notes/n1", { status: 409, body: { error: "conflict", reason: "overlap", conflicts: [], conflict_copy: { id: "c1", path: "a (conflict).md", revision: 1, content_hash: "hc" } } });
    await engine.editNote("n1", "mine\n");
    await drive(engine, clock, 10);
    const [problem] = await engine.problems();
    expect(problem).toMatchObject({ kind: "conflict", mineText: "mine\n", copy: { id: "c1" } });
  });

  it("refuses a path the server would refuse, before anything is queued", async () => {
    const { engine, store } = setup();
    await expect(engine.createNote("CON.md", "x")).rejects.toMatchObject({ reason: "reserved_name" });
    expect(await store.transaction(async (tx) => tx.listQueue())).toHaveLength(0);
  });
});

describe("restore (D12)", () => {
  it("after confirmation it adopts the server and re-creates what the server lost, with the same ids", async () => {
    const { engine, transport, store, clock } = setup({ pageSize: 10 });
    transport.reply("GET /api/changes", page({
      changes: [
        { entity_type: "task", entity_id: "keep", operation: "upsert", cursor: 1, revision: 2, data: taskData("keep", 2, "K") },
        { entity_type: "task", entity_id: "lost", operation: "upsert", cursor: 2, revision: 3, data: taskData("lost", 3, "L") },
      ],
      next_since: 2,
    }));
    await drive(engine, clock, 10);
    transport.reply("GET /api/changes",
      { status: 200, body: { ...EMPTY_PAGE, since: 2, resync_required: true, resync_reason: "cursor_ahead", next_since: 1 } },
      page({ changes: [{ entity_type: "task", entity_id: "keep", operation: "upsert", cursor: 1, revision: 2, data: taskData("keep", 2, "K") }], next_since: 1 }));
    transport.reply("POST /api/tasks", { status: 201, body: taskData("lost", 1, "L") });
    engine.requestPull();
    await drive(engine, clock, 10);
    expect((await engine.getStatus()).state).toBe("restore_confirmation");
    await engine.confirmRestore();
    await drive(engine, clock, 40);
    const create = writes(transport).find((r) => r.path === "/api/tasks")!;
    expect(create.body).toMatchObject({ id: "lost", title: "L" });
    const entities = await store.transaction(async (tx) => tx.listEntities());
    expect(entities.find((e) => e.id === "keep")!.server!.revision).toBe(2);
    expect((await engine.getStatus()).state).not.toBe("restore_confirmation");
  });
});

describe("status", () => {
  it("is observable", async () => {
    const { engine, transport, clock } = setup();
    transport.reply("GET /api/changes", page({}));
    const seen: string[] = [];
    engine.subscribe((s) => seen.push(`${s.state}:${s.pending}`));
    await engine.createEntity("task", { title: "x" });
    transport.reply("POST /api/tasks", { status: 201, body: taskData("x", 1, "x") });
    await drive(engine, clock, 10);
    expect(seen.some((s) => s.endsWith(":1"))).toBe(true);
    expect(seen[seen.length - 1]).toMatch(/:0$/);
  });
});
