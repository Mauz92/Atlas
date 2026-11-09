import { ACTED_AT_MIN_DELAY_MS, SyncEngine, type EngineOptions } from "./engine.ts";
import { SyncActionSink, SyncReminderSource } from "./reminders.ts";
import { fixedClock, seededRandom, sequenceIds, silentLogger } from "./testing/fakes.ts";
import { MemoryStore } from "./testing/memoryStore.ts";
import { ScriptedTransport } from "./testing/scriptedTransport.ts";
import { KeyValueLocalStore } from "./adapters/keyValueStore.ts";

const EMPTY_PAGE = { changes: [], since: 0, next_since: 0, has_more: false, resync_required: false, resync_reason: null };
const page = (over: Record<string, unknown>) => ({ status: 200, body: { ...EMPTY_PAGE, ...over } });
const INSTANCE = { status: 200, body: { sync: { epoch: "e1" } } };

const taskData = (id: string, revision: number, extra: Record<string, unknown> = {}) => ({
  id, revision, title: `T-${id}`, description: null, priority: "none", status: "inbox", due_at: "2026-03-26T12:00:00Z",
  time_zone: null, reminder_policy_id: null, deleted_at: null, field_revisions: { title: 1, status: 1, due_at: 1 }, ...extra,
});
const reminderData = (id: string, revision: number, taskId: string, extra: Record<string, unknown> = {}) => ({
  id, revision, task_id: taskId, state: "armed", remind_at: "2026-03-26T09:00:00Z", snoozed_until: null,
  acknowledged_at: null, effective_at: "2026-03-26T09:00:00Z", server_delivered_at: null, ...extra,
});
const row = (type: string, id: string, cursor: number, data: Record<string, unknown>, operation = "upsert") => ({
  entity_type: type, entity_id: id, operation, cursor, revision: data["revision"], data,
});

function setup(options: Partial<EngineOptions> = {}, transport = new ScriptedTransport(), store = new MemoryStore(), seed = 1) {
  const clock = fixedClock();
  const engine = new SyncEngine({
    store, transport, clock, ids: sequenceIds(seed), random: seededRandom(2), logger: silentLogger,
    options: { pullIntervalMs: 1000, pullJitterMs: 0, resyncMinIntervalMs: 0, reminders: true, ...options },
  });
  if (!transport.requests.length) transport.reply("GET /api/instance", INSTANCE);
  return { engine, transport, store, clock };
}

async function drive(engine: SyncEngine, clock: ReturnType<typeof fixedClock>, rounds = 40) {
  for (let i = 0; i < rounds; i++) {
    await engine.tick();
    await engine.settled();
    clock.advance(10);
  }
}

const feedRequests = (t: ScriptedTransport) => t.requests.filter((r) => r.path === "/api/changes");

describe("types negotiation and the reminder mirror", () => {
  it("asks for reminder with the other types and records them as synced at the first page", async () => {
    const { engine, transport, store, clock } = setup();
    transport.reply("GET /api/changes", page({
      changes: [row("task", "t1", 1, taskData("t1", 1)), row("reminder", "r1", 2, reminderData("r1", 1, "t1"))],
      next_since: 2,
    }));
    await drive(engine, clock);
    expect(feedRequests(transport)[0]!.query!["types"]).toBe("task,project,note,resolution,reminder");
    expect(store.peek().meta.get("types_synced")).toEqual(["task", "project", "note", "resolution", "reminder"]);
    const views = await engine.reminderViews();
    expect(views).toHaveLength(1);
    expect(views[0]!.reminder).toMatchObject({ id: "r1", taskId: "t1", state: "armed", revision: 1, effectiveAt: "2026-03-26T09:00:00Z" });
    expect(views[0]!.task).toEqual({ open: true, dirty: false, title: "T-t1" });
    expect((await engine.views()).map((v) => v.id)).toEqual(["t1"]); // a reminder is not a task or note
  });

  it("is unchanged for a host that does not opt in", async () => {
    const { engine, transport, clock } = setup({ reminders: false });
    transport.reply("GET /api/changes", page({
      changes: [row("reminder", "r1", 1, reminderData("r1", 1, "t1"))], next_since: 1,
    }));
    await drive(engine, clock);
    expect(feedRequests(transport)[0]!.query!["types"]).toBe("task,project,note,resolution");
    expect(await engine.reminderViews()).toEqual([]); // not asked for, and ignored if sent
  });

  it("applies a newer revision, ignores an older one and drops a tombstoned reminder", async () => {
    const { engine, transport, clock } = setup({ pullIntervalMs: 10 });
    transport.reply("GET /api/changes",
      page({ changes: [row("reminder", "r1", 1, reminderData("r1", 3, "t1", { snoozed_until: "2026-03-26T10:00:00Z", effective_at: "2026-03-26T10:00:00Z" }))], next_since: 1 }),
      page({ changes: [row("reminder", "r1", 2, reminderData("r1", 2, "t1"))], since: 1, next_since: 2 }),
      page({ changes: [row("reminder", "r1", 3, { id: "r1", revision: 4, deleted_at: "x" }, "delete")], since: 2, next_since: 3 }),
    );
    await drive(engine, clock, 12);
    // revision 3 survived revision 2; then the tombstone (revision 4) removed it
    expect(await engine.reminderViews()).toEqual([]);
    expect((await engine.getStatus()).cursor).toBe(3);
  });

  it("a snapshot that no longer holds a reminder tombstones it and never re-creates it", async () => {
    const { engine, transport, store, clock } = setup({ pullIntervalMs: 10 });
    transport.reply("GET /api/changes",
      page({ changes: [row("reminder", "r1", 1, reminderData("r1", 1, "t1"))], next_since: 1 }),
      page({ resync_required: true, resync_reason: "below_floor", next_since: 5, since: 1 }),
      page({ changes: [], since: 0, next_since: 5 }),
    );
    await drive(engine, clock, 30);
    expect(await engine.reminderViews()).toEqual([]);
    expect(store.peek().entities.get("r1")?.deleted).toBe(true);
    expect(transport.requests.filter((r) => r.method === "POST")).toEqual([]);
  });
});

describe("backfill of a type new to the client (G7)", () => {
  async function legacyStore(): Promise<MemoryStore> {
    // a client without reminders, with a cursor of 7 and a task
    const t = new ScriptedTransport().reply("GET /api/instance", INSTANCE);
    t.reply("GET /api/changes", page({ changes: [row("task", "t1", 7, taskData("t1", 1))], next_since: 7 }));
    const { engine, store, clock } = setup({ reminders: false }, t);
    await drive(engine, clock, 10);
    expect(store.peek().meta.get("cursor")).toBe(7);
    store.peek().meta.delete("types_synced"); // a store written before the field existed
    return store;
  }

  it("walks since=0 for the new type alone, then resumes the main pull from the old cursor with it", async () => {
    const store = await legacyStore();
    const transport = new ScriptedTransport().reply("GET /api/instance", INSTANCE);
    transport.reply("GET /api/changes", (req) => {
      const q = req.query!;
      if (q["types"] === "reminder" && q["since"] === 0)
        return { status: 200, body: { ...EMPTY_PAGE, changes: [row("reminder", "r1", 3, reminderData("r1", 1, "t1"))], next_since: 3, has_more: true, head: 9 } };
      if (q["types"] === "reminder" && q["since"] === 3)
        return { status: 200, body: { ...EMPTY_PAGE, changes: [row("reminder", "r2", 8, reminderData("r2", 1, "t1"))], since: 3, next_since: 9, has_more: false, head: 9 } };
      return { status: 200, body: { ...EMPTY_PAGE, since: 7, next_since: 9 } };
    });
    const { engine, clock } = setup({}, transport, store, 5);
    // between the two backfill pages nothing may be visible or recorded
    await engine.tick();
    await engine.settled();
    expect(await engine.reminderViews()).toEqual([]);
    await drive(engine, clock, 30);

    const asked = feedRequests(transport).map((r) => ({ since: r.query!["since"], types: r.query!["types"], snapshot: r.query!["snapshot"] }));
    expect(asked[0]).toEqual({ since: 0, types: "reminder", snapshot: undefined });
    expect(asked[1]).toEqual({ since: 3, types: "reminder", snapshot: true });
    expect(asked[2]).toEqual({ since: 7, types: "task,project,note,resolution,reminder", snapshot: undefined });
    expect((await engine.reminderViews()).map((v) => v.reminder.id)).toEqual(["r1", "r2"]);
    expect((store.peek().meta.get("types_synced") as string[]).includes("reminder")).toBe(true);
  });

  it("a crash before the last page commits marks nothing synced and repeats the walk", async () => {
    const store = await legacyStore();
    const transport = new ScriptedTransport().reply("GET /api/instance", INSTANCE);
    transport.reply("GET /api/changes", (req) =>
      req.query!["types"] === "reminder"
        ? { status: 200, body: { ...EMPTY_PAGE, changes: [row("reminder", "r1", 3, reminderData("r1", 1, "t1"))], next_since: 9, head: 9 } }
        : { status: 200, body: { ...EMPTY_PAGE, since: 7, next_since: 9 } },
    );
    const { engine, clock } = setup({ backoff: { baseMs: 20, factor: 2, capMs: 40 } }, transport, store, 5);
    let n = 0;
    store.crashBeforeCommit = () => ++n === 1; // the transaction that would apply the walk and record the type
    await drive(engine, clock, 8);
    expect(feedRequests(transport).filter((r) => r.query!["types"] === "reminder").length).toBeGreaterThanOrEqual(2);
    await drive(engine, clock, 30);
    expect((await engine.reminderViews()).map((v) => v.reminder.id)).toEqual(["r1"]);
    expect(store.peek().meta.get("cursor")).toBe(9);
  });

  it("a type recorded as synced without the walk would skip rows (the planted defect shows it)", async () => {
    const store = await legacyStore();
    const transport = new ScriptedTransport().reply("GET /api/instance", INSTANCE);
    transport.reply("GET /api/changes", { status: 200, body: { ...EMPTY_PAGE, since: 7, next_since: 9 } });
    const { engine, clock } = setup({ plantedBugs: { typeSyncedWithoutBackfill: true } }, transport, store, 5);
    await drive(engine, clock, 10);
    expect(feedRequests(transport).every((r) => r.query!["since"] !== 0)).toBe(true); // no backfill walk was made
  });

  it("downgrade then upgrade: types_synced shrinks while reminders are off, so the upgrade backfills", async () => {
    const t1 = new ScriptedTransport().reply("GET /api/instance", INSTANCE);
    t1.reply("GET /api/changes", page({ changes: [row("reminder", "r1", 1, reminderData("r1", 1, "t1"))], next_since: 1 }));
    const a = setup({}, t1);
    await drive(a.engine, a.clock, 10);
    expect(a.store.peek().meta.get("types_synced")).toContain("reminder");
    const t2 = new ScriptedTransport().reply("GET /api/instance", INSTANCE);
    t2.reply("GET /api/changes", { status: 200, body: { ...EMPTY_PAGE, since: 1, next_since: 4 } });
    const b = setup({ reminders: false }, t2, a.store, 9);
    await drive(b.engine, b.clock, 10);
    expect(b.store.peek().meta.get("types_synced")).not.toContain("reminder");
    const t3 = new ScriptedTransport().reply("GET /api/instance", INSTANCE);
    t3.reply("GET /api/changes", { status: 200, body: { ...EMPTY_PAGE, since: 0, next_since: 4 } }); // the reminder is gone
    const c = setup({}, t3, a.store, 11);
    await drive(c.engine, c.clock, 10);
    expect(feedRequests(t3)[0]!.query).toMatchObject({ since: 0, types: "reminder" });
    expect(await c.engine.reminderViews()).toEqual([]); // absent from the walk: tombstoned
  });

  it("the key-value store reads a version 1 state and writes version 2", async () => {
    const kv = new Map<string, string>();
    const adapter = { read: async (k: string) => kv.get(k) ?? null, write: async (k: string, v: string) => void kv.set(k, v), remove: async (k: string) => void kv.delete(k) };
    kv.set("atlas-sync-core-state", JSON.stringify({ version: 1, entities: [], queue: [], meta: [["cursor", 3]], resolutions: [], problems: [], drafts: [] }));
    const store = new KeyValueLocalStore(adapter);
    expect(await store.transaction(async (tx) => tx.getMeta<number>("cursor"))).toBe(3);
    await store.transaction(async (tx) => tx.setMeta("x", 1));
    expect(JSON.parse(kv.get("atlas-sync-core-state")!).version).toBe(2);
    kv.set("atlas-sync-core-state", JSON.stringify({ version: 3, entities: [], queue: [], meta: [["cursor", 3]], resolutions: [], problems: [], drafts: [] }));
    expect(await new KeyValueLocalStore(adapter).transaction(async (tx) => tx.getMeta<number>("cursor"))).toBeUndefined(); // newer than the code: refused
  });
});

describe("the queued action operation", () => {
  async function withReminder(extra: Partial<EngineOptions> = {}) {
    const ctx = setup(extra);
    ctx.transport.reply("GET /api/changes", page({
      changes: [row("task", "t1", 1, taskData("t1", 1)), row("reminder", "r1", 2, reminderData("r1", 1, "t1"))], next_since: 2,
    }));
    await drive(ctx.engine, ctx.clock, 10);
    return ctx;
  }
  const answer = (revision: number, extra: Record<string, unknown> = {}) => ({
    status: 200, body: { reminder: reminderData("r1", revision, "t1", extra), applied: true, stale: false },
  });

  it("sends the action once with the action id as Idempotency-Key and applies the answer", async () => {
    const { engine, transport, clock } = await withReminder();
    transport.reply("POST /api/reminders/r1/actions", answer(2, { snoozed_until: "2026-03-26T10:00:00Z", effective_at: "2026-03-26T10:00:00Z" }));
    await engine.submitReminderAction({ actionId: "a1", reminderId: "r1", kind: "snooze", snooze: { kind: "seconds", seconds: 3600 }, baseRevision: 1 });
    expect(await engine.pendingReminderActionIds()).toEqual(["a1"]);
    await drive(engine, clock, 10);
    const posts = transport.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.headers["Idempotency-Key"]).toBe("a1");
    expect(posts[0]!.body).toEqual({ action_id: "a1", kind: "snooze", snooze_for_seconds: 3600, base_revision: 1 });
    expect(await engine.pendingReminderActionIds()).toEqual([]);
    expect((await engine.reminderViews())[0]!.reminder).toMatchObject({ revision: 2, effectiveAt: "2026-03-26T10:00:00Z" });
  });

  it("a lost answer retries the byte-identical request; a stale answer cannot roll the mirror back", async () => {
    const { engine, transport, clock } = await withReminder({ requestTimeoutMs: 50 });
    transport.reply("POST /api/reminders/r1/actions", { drop: true }, answer(2, { acknowledged_at: "2026-03-26T09:30:00Z" }));
    await engine.submitReminderAction({ actionId: "a2", reminderId: "r1", kind: "dismiss", baseRevision: 1 });
    await drive(engine, clock, 200);
    const posts = transport.requests.filter((r) => r.method === "POST");
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts[1]).toEqual(posts[0]);
    expect((await engine.getStatus()).pending).toBe(0);
  });

  it("submitting the same action id twice queues it once", async () => {
    const { engine } = await withReminder();
    const action = { actionId: "a3", reminderId: "r1", kind: "dismiss" as const, baseRevision: 1 };
    await engine.submitReminderAction(action);
    await engine.submitReminderAction(action);
    expect(await engine.pendingReminderActionIds()).toEqual(["a3"]);
  });

  it("refuses an action for an unknown reminder or a malformed snooze", async () => {
    const { engine } = await withReminder();
    await expect(engine.submitReminderAction({ actionId: "x", reminderId: "nope", kind: "dismiss", baseRevision: 1 })).rejects.toThrow(/unknown reminder/);
    await expect(engine.submitReminderAction({ actionId: "y", reminderId: "r1", kind: "snooze", baseRevision: 1 })).rejects.toThrow(/preset/);
    await expect(engine.submitReminderAction({ actionId: "z", reminderId: "r1", kind: "dismiss", snooze: { kind: "tomorrow_morning" }, baseRevision: 1 })).rejects.toThrow(/no snooze/);
  });

  it("acted_at is sent only when the action waited at least a minute (R-68) and is frozen at the first send", async () => {
    const { engine, transport, clock } = await withReminder({ requestTimeoutMs: 50 });
    const tapped = clock.wall;
    transport.reply("POST /api/reminders/r1/actions", { drop: true }, answer(2));
    await engine.submitReminderAction({ actionId: "late", reminderId: "r1", kind: "snooze", snooze: { kind: "seconds", seconds: 3600 }, baseRevision: 1, actedAt: tapped });
    clock.wall += ACTED_AT_MIN_DELAY_MS + 5_000; // offline for a while
    await drive(engine, clock, 200);
    const posts = transport.requests.filter((r) => r.method === "POST");
    expect(posts[0]!.body).toMatchObject({ acted_at: new Date(tapped).toISOString() });
    expect(posts[1]).toEqual(posts[0]);

    const { engine: e2, transport: t2, clock: c2 } = await withReminder();
    t2.reply("POST /api/reminders/r1/actions", answer(2));
    await e2.submitReminderAction({ actionId: "prompt", reminderId: "r1", kind: "dismiss", baseRevision: 1, actedAt: c2.wall });
    await drive(e2, c2, 10);
    expect(t2.requests.find((r) => r.method === "POST")!.body).not.toHaveProperty("acted_at");
  });

  it("a 404 drops the action silently; a 409 revision_ahead keeps a problem; neither reads /api/reminders/{id}", async () => {
    const { engine, transport, clock } = await withReminder();
    transport.reply("POST /api/reminders/r1/actions", { status: 404, body: { error: "not_found" } }, { status: 409, body: { error: "revision_ahead", current_revision: 1 } });
    await engine.submitReminderAction({ actionId: "n1", reminderId: "r1", kind: "dismiss", baseRevision: 1 });
    await drive(engine, clock, 10);
    expect(await engine.problems()).toEqual([]);
    await engine.submitReminderAction({ actionId: "n2", reminderId: "r1", kind: "dismiss", baseRevision: 5 });
    await drive(engine, clock, 10);
    const problems = await engine.problems();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: "failed", code: "revision_ahead", entityType: "reminder" });
    expect((await engine.getStatus()).pending).toBe(0);
    expect(transport.requests.some((r) => r.method === "GET" && r.path.startsWith("/api/reminders"))).toBe(false);
  });

  it("a revoked device stops at the action's 401 like at any other request", async () => {
    const { engine, transport, clock } = await withReminder();
    transport.reply("POST /api/reminders/r1/actions", { status: 401, body: { error: "token_revoked" } });
    await engine.submitReminderAction({ actionId: "r", reminderId: "r1", kind: "dismiss", baseRevision: 1 });
    await drive(engine, clock, 10);
    expect((await engine.getStatus()).state).toBe("signed_out");
    const sent = transport.requests.length;
    await drive(engine, clock, 10);
    expect(transport.requests.length).toBe(sent);
  });

  it("the adapters expose the queue and submit through the engine", async () => {
    const { engine } = await withReminder();
    const source = new SyncReminderSource(engine);
    const sink = new SyncActionSink(engine);
    await sink.submit({ actionId: "s1", reminderId: "r1", kind: "dismiss", baseRevision: 1 });
    expect(await source.pendingActionIds()).toEqual(["s1"]);
    expect((await source.views()).length).toBe(1);
  });
});

describe("local edits make a reminder dirty or closed (14.2 rule 2)", () => {
  async function withReminder(extra: Partial<EngineOptions> = {}) {
    const ctx = setup(extra);
    ctx.transport.reply("GET /api/changes", page({
      changes: [row("task", "t1", 1, taskData("t1", 1)), row("reminder", "r1", 2, reminderData("r1", 1, "t1"))], next_since: 2,
    }));
    await drive(ctx.engine, ctx.clock, 10);
    return ctx;
  }

  it("a pending due-date edit marks the task dirty, completion closes it, an unrelated edit changes nothing", async () => {
    const { engine } = await withReminder();
    await engine.updateEntity("task", "t1", { title: "renamed" });
    expect((await engine.reminderViews())[0]!.task).toMatchObject({ open: true, dirty: false, title: "renamed" });
    await engine.updateEntity("task", "t1", { due_at: "2026-03-27T12:00:00Z" });
    expect((await engine.reminderViews())[0]!.task.dirty).toBe(true);
    await engine.updateEntity("task", "t1", { status: "done" });
    expect((await engine.reminderViews())[0]!.task).toMatchObject({ open: false, dirty: true });
  });

  it("a locally deleted task is closed at once", async () => {
    const { engine } = await withReminder();
    await engine.deleteEntity("task", "t1");
    expect((await engine.reminderViews())[0]!.task.open).toBe(false);
  });

  it("dirty outlives the acknowledgement and ends only when a pull that started after it completes", async () => {
    const { engine, transport, clock } = await withReminder({ pullIntervalMs: 200 });
    transport.reply("PATCH /api/tasks/t1", { status: 200, body: { ...taskData("t1", 2, { due_at: "2026-03-27T12:00:00Z" }), sync: { revision: 2, resolution: [], conflicts: [] } } });
    // the next pull has two pages: the task row first, the recomputed reminder on the second
    transport.reply("GET /api/changes",
      page({ changes: [row("task", "t1", 3, taskData("t1", 2, { due_at: "2026-03-27T12:00:00Z" }))], since: 2, next_since: 3, has_more: true }),
      page({ changes: [row("reminder", "r1", 4, reminderData("r1", 2, "t1", { remind_at: "2026-03-27T09:00:00Z", effective_at: "2026-03-27T09:00:00Z" }))], since: 3, next_since: 4 }),
      page({ since: 4, next_since: 4 }),
    );
    await engine.updateEntity("task", "t1", { due_at: "2026-03-27T12:00:00Z" });
    // push it (the pull timer has not elapsed yet)
    for (let i = 0; i < 6 && (await engine.getStatus()).pending > 0; i++) {
      await engine.tick();
      await engine.settled();
      clock.advance(10);
    }
    expect((await engine.getStatus()).pending).toBe(0);
    expect((await engine.reminderViews())[0]!.task.dirty).toBe(true); // acknowledged, the reminder not yet recomputed here
    clock.advance(500);
    await engine.tick(); // first page of the walk: the task row only
    await engine.settled();
    expect((await engine.reminderViews())[0]!.task.dirty).toBe(true);
    expect((await engine.reminderViews())[0]!.reminder.revision).toBe(1);
    await drive(engine, clock, 6); // second page: the reminder arrives, the pull completes
    const after = (await engine.reminderViews())[0]!;
    expect(after.reminder.revision).toBe(2);
    expect(after.task.dirty).toBe(false);
  });

  it("the planted defect (dirty dropped at the acknowledgement) is visible here", async () => {
    const { engine, transport, clock } = await withReminder({ plantedBugs: { clearDirtyAtAck: true }, pullIntervalMs: 100_000 });
    transport.reply("PATCH /api/tasks/t1", { status: 200, body: { ...taskData("t1", 2, { status: "next" }), sync: { revision: 2, resolution: [], conflicts: [] } } });
    await engine.updateEntity("task", "t1", { status: "next" });
    await drive(engine, clock, 6);
    expect((await engine.reminderViews())[0]!.task.dirty).toBe(false);
  });

  it("dirty survives a restart and is cleared by the first pull that completes afterwards", async () => {
    const first = await withReminder({ pullIntervalMs: 100_000 });
    first.transport.reply("PATCH /api/tasks/t1", { status: 200, body: { ...taskData("t1", 2, { due_at: "2026-03-27T12:00:00Z" }), sync: { revision: 2, resolution: [], conflicts: [] } } });
    await first.engine.updateEntity("task", "t1", { due_at: "2026-03-27T12:00:00Z" });
    await drive(first.engine, first.clock, 6);
    expect((await first.engine.getStatus()).pending).toBe(0);
    expect((await first.engine.reminderViews())[0]!.task.dirty).toBe(true);
    first.engine.dispose();
    const transport = new ScriptedTransport().reply("GET /api/instance", INSTANCE);
    transport.reply("GET /api/changes", { status: 200, body: { ...EMPTY_PAGE, since: 2, next_since: 4, changes: [row("reminder", "r1", 4, reminderData("r1", 2, "t1", { remind_at: "2026-03-27T09:00:00Z", effective_at: "2026-03-27T09:00:00Z" }))] } });
    transport.reply("GET /api/tasks/t1", { status: 200, body: taskData("t1", 2, { due_at: "2026-03-27T12:00:00Z" }) }); // the re-read after the acknowledged write
    const second = setup({}, transport, first.store, 3);
    await drive(second.engine, second.clock, 6);
    expect((await second.engine.reminderViews())[0]!.task.dirty).toBe(false);
    expect((await second.engine.reminderViews())[0]!.reminder.revision).toBe(2);
  });
});
