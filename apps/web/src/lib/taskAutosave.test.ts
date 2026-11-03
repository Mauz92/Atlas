import { ApiError, type Task, type TaskFields } from "../api/client";
import { makeTask } from "../test/tasks";
import {
  TaskAutosave,
  forgetSession,
  openSession,
  releaseSession,
  resetSessions,
  type SendUpdate,
} from "./taskAutosave";

/**
 * The save coordinator behind the task detail (UX-04, ADR-0053). A fake server applies each PATCH
 * to its copy of the task and bumps the revision, and can be told to hold, fail or reject requests.
 */
interface Call {
  base: number;
  fields: TaskFields;
  key: string;
  keepalive: boolean;
}

function server(initial: Task) {
  let current = initial;
  let keys = 0;
  const calls: Call[] = [];
  const held: (() => void)[] = [];
  let hold = false;
  let failNext: unknown[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const send: SendUpdate = async (task, fields, options) => {
    calls.push({
      base: task.revision,
      fields,
      key: options.idempotencyKey,
      keepalive: options.keepalive === true,
    });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (hold) await new Promise<void>((resolve) => held.push(resolve));
      const failure = failNext.shift();
      if (failure) throw failure;
      if (task.revision !== current.revision) {
        throw new ApiError(409, "revision conflict", {
          detail: { current_revision: current.revision },
        });
      }
      const next: Task = {
        ...current,
        ...(fields as Partial<Task>),
        revision: current.revision + 1,
      };
      if ("tags" in fields) next.tags = [...(fields.tags ?? [])].sort();
      current = next;
      return next;
    } finally {
      inFlight -= 1;
    }
  };

  return {
    send,
    calls,
    get current() {
      return current;
    },
    /** Someone else edits the task (another tab). */
    changeElsewhere(patch: Partial<Task>) {
      current = { ...current, ...patch, revision: current.revision + 1 };
    },
    holdRequests(on: boolean) {
      hold = on;
    },
    async releaseOne() {
      held.shift()?.();
      await settle();
    },
    fail(...errors: unknown[]) {
      failNext = errors;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    newKey: () => `key-${++keys}`,
  };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

const base = makeTask({
  id: "t1",
  title: "Buy milk",
  priority: "low",
  revision: 1,
  time_zone: "UTC",
});

function session(fake = server(base), online = () => true) {
  const auto = new TaskAutosave({
    task: base,
    send: fake.send,
    viewerZone: "UTC",
    isOnline: online,
    newKey: fake.newKey,
  });
  return { auto, fake };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSessions();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("TaskAutosave", () => {
  it("debounces text: one PATCH with the last value after the pause", async () => {
    const { auto, fake } = session();
    auto.edit({ title: "Buy" }, "debounce");
    auto.edit({ title: "Buy oat" }, "debounce");
    auto.edit({ title: "Buy oat milk" }, "debounce");
    expect(auto.getSnapshot().state).toBe("saving");
    await vi.advanceTimersByTimeAsync(599);
    expect(fake.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(fake.calls).toEqual([
      { base: 1, fields: { title: "Buy oat milk" }, key: "key-1", keepalive: false },
    ]);
    expect(auto.getSnapshot().state).toBe("saved");
    expect(auto.getSnapshot().task.revision).toBe(2);
  });

  it("never sends two requests at once and coalesces edits queued behind one", async () => {
    const { auto, fake } = session();
    fake.holdRequests(true);
    auto.edit({ title: "B" }, "now");
    await settle();
    expect(fake.calls).toHaveLength(1);
    // A fast typist keeps going while the first save is in flight.
    for (const text of ["Bu", "Buy", "Buy m", "Buy milk!"]) {
      auto.edit({ title: text }, "debounce");
      await vi.advanceTimersByTimeAsync(700);
    }
    auto.edit({ priority: "high" }, "now");
    await settle();
    expect(fake.calls).toHaveLength(1);
    expect(auto.getSnapshot().state).toBe("saving");

    await fake.releaseOne();
    await fake.releaseOne();
    await fake.releaseOne();
    expect(fake.maxInFlight).toBe(1);
    expect(auto.maxConcurrent).toBe(1);
    // Each request is built on the revision the previous one returned: no self-conflict.
    expect(fake.calls.map((call) => [call.base, call.fields])).toEqual([
      [1, { title: "B" }],
      [2, { title: "Buy milk!" }],
      [3, { priority: "high" }],
    ]);
    expect(new Set(fake.calls.map((call) => call.key)).size).toBe(3);
    expect(auto.getSnapshot().state).toBe("saved");
    expect(fake.current).toMatchObject({ title: "Buy milk!", priority: "high", revision: 4 });
  });

  it("sends one property group per request, dates and zone together", async () => {
    const { auto, fake } = session();
    auto.edit({ dueDate: "2026-11-10", dueTime: "09:30" }, "debounce");
    auto.edit({ tags: "work, home" }, "now");
    await settle();
    await auto.flush();
    expect(fake.calls.map((call) => call.fields)).toEqual([
      { due_at: "2026-11-10T09:30:00" },
      { tags: ["work", "home"] },
    ]);
  });

  it("an edit right after a flush with nothing to send is not stranded (blur, then a menu choice)", async () => {
    const { auto, fake } = session();
    const flushed = auto.flush(); // leaving the title: nothing pending
    auto.edit({ priority: "urgent" }, "now"); // the menu choice in the same tick
    await flushed;
    await settle();
    expect(fake.calls.map((call) => call.fields)).toEqual([{ priority: "urgent" }]);
    expect(auto.getSnapshot().state).toBe("saved");
  });

  it("does not send an edit typed back to the server's value", async () => {
    const { auto, fake } = session();
    auto.edit({ title: "Buy milk?" }, "debounce");
    auto.edit({ title: "Buy milk" }, "debounce");
    expect(await auto.flush()).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it("flushes at once on close/switch/page hide, without waiting for the pause", async () => {
    const { auto, fake } = session();
    auto.edit({ description: "Semi-skimmed" }, "debounce");
    const done = auto.flush({ keepalive: true });
    await settle();
    expect(fake.calls).toEqual([
      { base: 1, fields: { description: "Semi-skimmed" }, key: "key-1", keepalive: true },
    ]);
    expect(await done).toBe(true);
    // The pause timer was cancelled: nothing more is sent later.
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.calls).toHaveLength(1);
  });

  it("a stale edit becomes a conflict: nothing is overwritten and local values are kept", async () => {
    const { auto, fake } = session();
    fake.changeElsewhere({ title: "Buy milk (edited)" });
    auto.edit({ priority: "urgent" }, "now");
    await settle();
    let snap = auto.getSnapshot();
    expect(snap.state).toBe("conflict");
    expect(snap.draft.priority).toBe("urgent");
    expect(snap.unsaved).toEqual(["priority"]);
    expect(fake.current).toMatchObject({ title: "Buy milk (edited)", priority: "low" });

    // Further edits are kept but not sent while the conflict stands.
    auto.edit({ description: "Two litres" }, "now");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.calls).toHaveLength(1);
    expect(await auto.flush()).toBe(false);

    // Load latest: the fields show the server, the local values are set aside for reapplying.
    auto.loadLatest(fake.current);
    snap = auto.getSnapshot();
    expect(snap.state).toBe("saved");
    expect(snap.draft).toMatchObject({ title: "Buy milk (edited)", priority: "low" });
    expect(snap.stash).toEqual({ priority: "urgent", description: "Two litres" });

    auto.reapply();
    await auto.flush();
    expect(fake.current).toMatchObject({
      title: "Buy milk (edited)",
      priority: "urgent",
      description: "Two litres",
    });
    expect(auto.getSnapshot().stash).toBeNull();
  });

  it("a 422 keeps the text, reports the server's words on that field and does not block others", async () => {
    const { auto, fake } = session();
    const message = "title: String should have at least 1 character";
    fake.fail(new ApiError(422, message));
    auto.edit({ title: "" }, "debounce");
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    let snap = auto.getSnapshot();
    expect(snap.draft.title).toBe("");
    // Came from a pause in typing: recorded, not shouted yet.
    expect(snap.errors.title).toEqual({ message, shown: false });
    expect(snap.state).toBe("unsaved");

    // Leaving the field (a flush) shows it verbatim; the rejected value is not re-sent.
    expect(await auto.flush()).toBe(false);
    snap = auto.getSnapshot();
    expect(snap.errors.title).toEqual({ message, shown: true });
    expect(snap.state).toBe("invalid");
    expect(fake.calls).toHaveLength(1);

    // Another field still saves.
    auto.edit({ priority: "high" }, "now");
    await settle();
    expect(fake.current.priority).toBe("high");
    expect(auto.getSnapshot().draft.title).toBe("");

    // A new value clears the error and saves.
    auto.edit({ title: "Buy bread" }, "debounce");
    expect(await auto.flush()).toBe(true);
    expect(auto.getSnapshot().errors).toEqual({});
    expect(fake.current.title).toBe("Buy bread");
  });

  it("offline: nothing is sent, the edit is kept, and it is sent when back online", async () => {
    let online = false;
    const { auto, fake } = session(server(base), () => online);
    auto.edit({ title: "Buy milk offline" }, "now");
    await settle();
    expect(fake.calls).toHaveLength(0);
    expect(auto.getSnapshot().state).toBe("offline");
    expect(auto.getSnapshot().draft.title).toBe("Buy milk offline");
    expect(await auto.flush()).toBe(false);

    online = true;
    expect(await auto.retry()).toBe(true);
    expect(fake.current.title).toBe("Buy milk offline");
  });

  it("a network failure re-sends the same request under the same key (applied once)", async () => {
    const { auto, fake } = session();
    fake.fail(new TypeError("Failed to fetch"));
    auto.edit({ title: "Buy soy milk" }, "now");
    await settle();
    expect(auto.getSnapshot().state).toBe("offline");
    expect(auto.getSnapshot().unsaved).toEqual(["title"]);

    // The next edit retries the unconfirmed request first, then sends the new one.
    auto.edit({ priority: "medium" }, "now");
    await settle();
    expect(fake.calls.map((call) => [call.key, call.base, call.fields])).toEqual([
      ["key-1", 1, { title: "Buy soy milk" }],
      ["key-1", 1, { title: "Buy soy milk" }],
      ["key-2", 2, { priority: "medium" }],
    ]);
    expect(auto.getSnapshot().state).toBe("saved");
  });

  it("a server error shows 'failed' and Retry re-sends the same request", async () => {
    const { auto, fake } = session();
    fake.fail(new ApiError(503, "Service Unavailable"));
    auto.edit({ title: "Buy rice milk" }, "now");
    await settle();
    expect(auto.getSnapshot()).toMatchObject({ state: "failed", failure: "Service Unavailable" });
    expect(await auto.retry()).toBe(true);
    expect(fake.calls.map((call) => call.key)).toEqual(["key-1", "key-1"]);
  });

  it("keeps the focused field's text when a save comes back normalised, and adopts it on blur", async () => {
    const { auto, fake } = session();
    auto.setFocus("tags");
    auto.edit({ tags: "work, Offsite ,work" }, "now");
    await settle();
    expect(fake.current.tags).toEqual(["Offsite", "work", "work"].sort());
    expect(auto.getSnapshot().draft.tags).toBe("work, Offsite ,work");
    auto.setFocus(null);
    expect(auto.getSnapshot().draft.tags).toBe((fake.current.tags ?? []).join(", "));
  });

  it("takes the server's value for untouched fields of a group that still has a queued edit", async () => {
    // Regression: the first due-date save pins the viewer's zone on the server; a time typed while
    // that request is in flight must not send `time_zone: null` afterwards.
    const noZone = { ...base, time_zone: null };
    const fake = server(noZone);
    const auto = new TaskAutosave({ task: noZone, send: fake.send, viewerZone: "Europe/Stockholm", newKey: fake.newKey });
    fake.holdRequests(true);
    auto.edit({ dueDate: "2026-11-08" }, "now");
    await settle();
    auto.edit({ dueTime: "09:30" }, "debounce");
    fake.holdRequests(false);
    await fake.releaseOne();
    // The fake server does not pin; emulate the real one doing so in its answer.
    expect(fake.calls[0].fields).toEqual({ due_at: "2026-11-08T23:59:00", time_zone: "Europe/Stockholm" });
    expect(await auto.flush()).toBe(true);
    expect(fake.calls[1].fields).toEqual({ due_at: "2026-11-08T09:30:00" });
    expect(auto.getSnapshot().draft).toMatchObject({ timeZone: "Europe/Stockholm", dueTime: "09:30" });
  });

  it("adopts a newer version from outside only when nothing is pending", () => {
    const { auto } = session();
    expect(auto.adopt({ ...base, status: "completed", revision: 2 })).toBe(true);
    expect(auto.getSnapshot().draft.status).toBe("completed");
    auto.edit({ title: "Local" }, "hold");
    expect(auto.adopt({ ...base, title: "Remote", revision: 3 })).toBe(false);
    expect(auto.getSnapshot().draft.title).toBe("Local");
  });

  it("'hold' edits wait for a flush (no request on a half-typed rule)", async () => {
    const { auto, fake } = session();
    auto.edit({ recurrenceRule: "FREQ=WEEK" }, "hold");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.calls).toHaveLength(0);
    expect(auto.getSnapshot().state).toBe("unsaved");
    auto.edit({ recurrenceRule: "FREQ=WEEKLY" }, "hold");
    expect(await auto.flush()).toBe(true);
    expect(fake.calls.map((call) => call.fields)).toEqual([
      { recurrence_rule: "FREQ=WEEKLY" },
    ]);
  });

  it("discard throws local edits away explicitly", async () => {
    const { auto, fake } = session();
    auto.edit({ title: "Never mind" }, "hold");
    auto.discard();
    expect(auto.getSnapshot()).toMatchObject({ state: "saved", unsaved: [] });
    expect(auto.getSnapshot().draft.title).toBe("Buy milk");
    expect(await auto.flush()).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("session registry", () => {
  it("keeps a session with unsaved edits after the panel is released, so reopening shows them", async () => {
    let online = false;
    const fake = server(base);
    const options = { task: base, send: fake.send, viewerZone: "UTC", isOnline: () => online };
    const first = openSession(options);
    first.edit({ title: "Typed while offline" }, "debounce");
    releaseSession(first);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);

    const again = openSession(options);
    expect(again).toBe(first);
    expect(again.getSnapshot().draft.title).toBe("Typed while offline");
    online = true;
    expect(await again.flush()).toBe(true);

    // Clean now: releasing drops it, and the next open starts from the server's version.
    releaseSession(again);
    await settle();
    const fresh = openSession({ ...options, task: fake.current });
    expect(fresh).not.toBe(first);
    expect(fresh.getSnapshot().draft.title).toBe("Typed while offline");
  });

  it("closing flushes a pending edit; delete after the flush forgets the session", async () => {
    const fake = server(base);
    const auto = openSession({ task: base, send: fake.send, viewerZone: "UTC" });
    auto.edit({ title: "Typed then deleted" }, "debounce");
    expect(await auto.flush()).toBe(true);
    expect(fake.current.title).toBe("Typed then deleted");
    forgetSession(base.id);
    expect(auto.disposed).toBe(true);
    expect(openSession({ task: fake.current, send: fake.send })).not.toBe(auto);
  });
});
