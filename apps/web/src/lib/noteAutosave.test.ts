import {
  NoteAutosave,
  NoteSessions,
  memoryDraftStore,
  type NoteStore,
  type NoteVersion,
} from "./noteAutosave";

/**
 * The note save engine (UX-05, ADR-0054) against a fake server that applies each `PUT` to its copy
 * of the note, checks `base_revision`, and can be told to hold, fail or lose answers. No React, no
 * DOM: the same suite documents what a desktop host can rely on.
 */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message = `HTTP ${status}`,
  ) {
    super(message);
  }
}

interface Call {
  content: string;
  base: number;
  keepalive: boolean;
}

function fakeServer(initial: NoteVersion) {
  let current = initial;
  const calls: Call[] = [];
  const copies: string[] = [];
  const held: (() => void)[] = [];
  let hold = false;
  let inFlight = 0;
  let maxInFlight = 0;
  /** Outcomes consumed by the next requests: "network" (not applied), "lost" (applied, answer lost), 5xx/4xx. */
  const script: ("network" | "lost" | number)[] = [];
  let readFails = 0;
  let reconciles = 0;

  const store: NoteStore = {
    async update(id, content, base, options) {
      calls.push({ content, base, keepalive: options.keepalive === true });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (hold) await new Promise<void>((resolve) => held.push(resolve));
        const step = script.shift();
        if (step === "network") throw new TypeError("Failed to fetch");
        if (typeof step === "number") throw new HttpError(step);
        if (base !== current.revision) throw new HttpError(409, "revision conflict");
        current = { id, revision: current.revision + 1, content };
        if (step === "lost") throw new TypeError("Failed to fetch");
        return current;
      } finally {
        inFlight -= 1;
      }
    },
    async read() {
      if (readFails > 0) {
        readFails -= 1;
        throw new TypeError("Failed to fetch");
      }
      return current;
    },
    async reconcile() {
      reconciles += 1;
    },
    async saveConflictCopy(_id, content) {
      copies.push(content);
      return { path: "Note (conflict).md" };
    },
  };

  return {
    store,
    calls,
    copies,
    script,
    get reconciles() {
      return reconciles;
    },
    get current() {
      return current;
    },
    /** Someone else (an editor on disk, another tab) changes the note. */
    external(content: string) {
      current = { ...current, revision: current.revision + 1, content };
    },
    failReads(count: number) {
      readFails = count;
    },
    hold() {
      hold = true;
    },
    release() {
      hold = false;
      held.splice(0).forEach((resolve) => resolve());
    },
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

const NOTE: NoteVersion = { id: "n1", revision: 1, content: "# Title\n" };

function setup(options: { note?: NoteVersion; online?: { value: boolean }; drafts?: ReturnType<typeof memoryDraftStore> } = {}) {
  const server = fakeServer(options.note ?? NOTE);
  const drafts = options.drafts ?? memoryDraftStore();
  const online = options.online ?? { value: true };
  const session = new NoteAutosave({
    note: options.note ?? NOTE,
    store: server.store,
    drafts,
    isOnline: () => online.value,
    now: () => 1_000,
  });
  return { server, drafts, online, session };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("NoteAutosave: when and how much is sent", () => {
  it("sends nothing until the typing pauses, then one request with the latest text", async () => {
    const { server, session } = setup();
    for (const text of ["# Title\na", "# Title\nab", "# Title\nabc"]) {
      session.change(text);
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(server.calls).toHaveLength(0);
    expect(session.getSnapshot().state).toBe("unsaved");
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.calls).toEqual([{ content: "# Title\nabc", base: 1, keepalive: false }]);
    expect(session.getSnapshot()).toMatchObject({ state: "saved", dirty: false });
    expect(session.getSnapshot().note.revision).toBe(2);
  });

  it("never has two requests in flight and chains the revision from each answer", async () => {
    const { server, session } = setup();
    server.hold();
    session.change("one");
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.getSnapshot().state).toBe("saving");
    // Typed while the first request is out: queued, not sent.
    session.change("one two");
    session.change("one two three");
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.calls).toHaveLength(1);
    server.release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.calls.map((call) => [call.content, call.base])).toEqual([
      ["one", 1],
      ["one two three", 2],
    ]);
    expect(server.maxInFlight).toBe(1);
    expect(server.current.content).toBe("one two three");
    expect(session.getSnapshot().state).toBe("saved");
  });

  it("sends nothing when the text is typed back to what the server holds", async () => {
    const { server, drafts, session } = setup();
    session.change("# Title\nx");
    expect(drafts.entries.has("n1")).toBe(true);
    session.change(NOTE.content);
    await vi.advanceTimersByTimeAsync(5000);
    expect(server.calls).toHaveLength(0);
    expect(drafts.entries.has("n1")).toBe(false);
    expect(session.getSnapshot().state).toBe("saved");
  });

  it("flush sends at once (switching notes, closing) and reports whether the server has the text", async () => {
    const { server, session } = setup();
    session.change("typed");
    await expect(session.flush()).resolves.toBe(true);
    expect(server.calls).toHaveLength(1);
    expect(server.current.content).toBe("typed");
    // Nothing pending: no request.
    await expect(session.flush()).resolves.toBe(true);
    expect(server.calls).toHaveLength(1);
  });

  it("flushes every unsaved session on pagehide with keepalive", async () => {
    const sessions = new NoteSessions();
    const server = fakeServer(NOTE);
    const drafts = memoryDraftStore();
    const session = sessions.open({ note: NOTE, store: server.store, drafts });
    session.change("typed before the tab closed");
    await sessions.flushAll(true);
    expect(server.calls).toEqual([{ content: "typed before the tab closed", base: 1, keepalive: true }]);
    expect(server.current.content).toBe("typed before the tab closed");
  });
});

describe("NoteAutosave: the local draft", () => {
  it("is written synchronously on every change and cleared only after the server confirms", async () => {
    const { server, drafts, session } = setup();
    server.hold();
    session.change("a");
    expect(drafts.entries.get("n1")).toEqual({ content: "a", baseRevision: 1, savedAt: 1_000 });
    session.change("ab");
    expect(drafts.entries.get("n1")?.content).toBe("ab");

    await vi.advanceTimersByTimeAsync(1000);
    // In flight: the draft stays, and records what may be applied.
    expect(drafts.entries.get("n1")).toMatchObject({ content: "ab", attempted: "ab" });
    server.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(drafts.entries.has("n1")).toBe(false);
    expect(session.getSnapshot().state).toBe("saved");
  });

  it("keeps the draft when the save fails or is refused", async () => {
    const { server, drafts, session } = setup();
    server.script.push("network");
    session.change("keep me");
    await session.flush();
    expect(drafts.entries.get("n1")?.content).toBe("keep me");
    server.script.push(422);
    session.change("keep me too");
    await session.flush();
    expect(drafts.entries.get("n1")?.content).toBe("keep me too");
  });

  it("drops a draft equal to the server's text when the note is opened", () => {
    const drafts = memoryDraftStore();
    drafts.write("n1", { content: NOTE.content, baseRevision: 1, savedAt: 1 });
    const { session } = setup({ drafts });
    expect(drafts.entries.has("n1")).toBe(false);
    expect(session.getSnapshot()).toMatchObject({ state: "saved", content: NOTE.content, restored: false });
  });

  it("puts back a draft typed on the revision the server still holds, and saves it", async () => {
    const drafts = memoryDraftStore();
    drafts.write("n1", { content: "# Title\ntyped before reload", baseRevision: 1, savedAt: 1 });
    const { server, session } = setup({ drafts });
    expect(session.getSnapshot()).toMatchObject({
      content: "# Title\ntyped before reload",
      restored: true,
      state: "unsaved",
    });
    // Nothing is sent until the host says it is listening.
    await vi.advanceTimersByTimeAsync(5000);
    expect(server.calls).toHaveLength(0);
    session.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.calls).toEqual([{ content: "# Title\ntyped before reload", base: 1, keepalive: false }]);
    expect(session.getSnapshot().state).toBe("saved");
    expect(drafts.entries.has("n1")).toBe(false);
  });

  it("never applies a draft typed on an older revision: shows it in conflict and sends nothing", async () => {
    const drafts = memoryDraftStore();
    drafts.write("n1", { content: "my old edit", baseRevision: 1, savedAt: 1 });
    const newer = { id: "n1", revision: 4, content: "changed on disk" };
    const { server, session } = setup({ note: newer, drafts });
    await vi.advanceTimersByTimeAsync(5000);
    expect(server.calls).toHaveLength(0);
    expect(session.getSnapshot()).toMatchObject({
      state: "conflict",
      content: "my old edit",
      conflictRevision: 4,
      restored: true,
    });
    expect(drafts.entries.get("n1")?.content).toBe("my old edit");
  });

  it("recognises a draft built on a request that was applied but never answered", () => {
    // The page went away while "A" was in flight; the user had already typed "AB".
    const drafts = memoryDraftStore();
    drafts.write("n1", { content: "AB", baseRevision: 1, savedAt: 1, attempted: "A" });
    const { server, session } = setup({ note: { id: "n1", revision: 2, content: "A" }, drafts });
    expect(session.getSnapshot()).toMatchObject({ state: "unsaved", content: "AB", conflictRevision: null });
    return session.flush().then(() => {
      expect(server.calls).toEqual([{ content: "AB", base: 2, keepalive: false }]);
    });
  });
});

describe("NoteAutosave: conflicts", () => {
  it("keeps the text and sends nothing more after a 409 mid-typing", async () => {
    const { server, drafts, session } = setup();
    session.change("# Title\nmine");
    server.external("# Title\nsomeone else");
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.calls).toHaveLength(1);
    expect(session.getSnapshot()).toMatchObject({
      state: "conflict",
      content: "# Title\nmine",
      conflictRevision: 2,
    });
    // More typing, long pauses, going online again, a flush: still nothing is sent.
    session.change("# Title\nmine, more");
    session.online();
    await vi.advanceTimersByTimeAsync(10_000);
    await session.flush();
    expect(server.calls).toHaveLength(1);
    expect(server.current.content).toBe("# Title\nsomeone else");
    expect(drafts.entries.get("n1")?.content).toBe("# Title\nmine, more");
  });

  it("brings the server's index up to date before reading the version to compare or show", async () => {
    const { server, session } = setup();
    session.change("mine");
    server.external("theirs");
    await session.flush();
    expect(server.reconciles).toBe(1);
    await session.reloadFromServer();
    expect(server.reconciles).toBe(2);
  });

  it("keep my version as a copy writes the copy, then shows the server's version", async () => {
    const { server, drafts, session } = setup();
    session.change("mine");
    server.external("theirs");
    await session.flush();
    const path = await session.keepMineAsCopy();
    expect(path).toBe("Note (conflict).md");
    expect(server.copies).toEqual(["mine"]);
    expect(session.getSnapshot()).toMatchObject({ state: "saved", content: "theirs", conflictRevision: null });
    expect(drafts.entries.has("n1")).toBe(false);
  });

  it("reload server version drops the local text", async () => {
    const { server, session } = setup();
    session.change("mine");
    server.external("theirs");
    await session.flush();
    await session.reloadFromServer();
    expect(session.getSnapshot()).toMatchObject({ state: "saved", content: "theirs" });
    expect(server.copies).toEqual([]);
    // Saving works again from the new revision.
    session.change("theirs and more");
    await session.flush();
    expect(server.current.content).toBe("theirs and more");
  });
});

describe("NoteAutosave: unknown outcomes", () => {
  it("re-sends the same request after a network failure and applies it once", async () => {
    const { server, session } = setup();
    server.script.push("network");
    session.change("hello");
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.getSnapshot().state).toBe("failed");
    expect(session.getSnapshot().content).toBe("hello");
    await session.retry();
    expect(server.calls.map((call) => [call.content, call.base])).toEqual([
      ["hello", 1],
      ["hello", 1],
    ]);
    expect(session.getSnapshot().state).toBe("saved");
  });

  it("a retry that answers 409 with the same text on the server counts as saved", async () => {
    const { server, drafts, session } = setup();
    server.script.push("lost"); // applied, but the answer never arrived
    session.change("applied once");
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.getSnapshot().state).toBe("failed");
    expect(server.current.revision).toBe(2);
    await session.retry(); // base 1 again -> 409 -> re-read -> identical text
    expect(server.calls).toHaveLength(2);
    expect(session.getSnapshot()).toMatchObject({ state: "saved", dirty: false, conflictRevision: null });
    expect(session.getSnapshot().note.revision).toBe(2);
    expect(drafts.entries.has("n1")).toBe(false);
  });

  it("a retry that answers 409 with different text on the server is a conflict", async () => {
    const { server, session } = setup();
    server.script.push("network");
    session.change("mine");
    await vi.advanceTimersByTimeAsync(1000);
    server.external("edited elsewhere meanwhile");
    await session.retry();
    expect(session.getSnapshot()).toMatchObject({
      state: "conflict",
      content: "mine",
      conflictRevision: 2,
    });
    expect(server.current.content).toBe("edited elsewhere meanwhile");
  });

  it("text typed after a lost answer is still sent, on the revision the first request created", async () => {
    const { server, session } = setup();
    server.script.push("lost");
    session.change("A");
    await vi.advanceTimersByTimeAsync(1000);
    session.change("AB");
    await session.flush();
    expect(server.current.content).toBe("AB");
    expect(session.getSnapshot()).toMatchObject({ state: "saved", dirty: false });
  });

  it("a 5xx is retried like a network failure", async () => {
    const { server, session } = setup();
    server.script.push(503);
    session.change("x");
    await session.flush();
    expect(session.getSnapshot().state).toBe("failed");
    await session.flush();
    expect(server.current.content).toBe("x");
  });

  it("a refused request (422) keeps the text with the server's message and is not re-sent until edited", async () => {
    const { server, session } = setup();
    server.script.push(422);
    session.change("too much");
    await session.flush();
    expect(session.getSnapshot()).toMatchObject({ state: "rejected", content: "too much", failure: "HTTP 422" });
    await vi.advanceTimersByTimeAsync(10_000);
    await session.flush();
    expect(server.calls).toHaveLength(1);
    session.change("less");
    await session.flush();
    expect(server.current.content).toBe("less");
  });

  it("if the note cannot be re-read after a 409 nothing is overwritten and it is looked at again", async () => {
    const { server, session } = setup();
    server.script.push("lost");
    session.change("v");
    await session.flush();
    server.failReads(1);
    await session.flush();
    expect(session.getSnapshot().state).toBe("failed");
    await session.flush();
    expect(session.getSnapshot()).toMatchObject({ state: "saved" });
  });
});

describe("NoteAutosave: offline", () => {
  it("sends nothing while offline, keeps the draft, and resends when the device is back online", async () => {
    const { server, drafts, online, session } = setup();
    online.value = false;
    session.change("typed offline");
    await vi.advanceTimersByTimeAsync(5000);
    expect(server.calls).toHaveLength(0);
    expect(session.getSnapshot().state).toBe("offline");
    expect(drafts.entries.get("n1")?.content).toBe("typed offline");

    online.value = true;
    session.online();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.current.content).toBe("typed offline");
    expect(session.getSnapshot().state).toBe("saved");
    expect(drafts.entries.has("n1")).toBe(false);
  });

  it("restores offline typing after a reload and sends it once online", async () => {
    const drafts = memoryDraftStore();
    const first = setup({ drafts, online: { value: false } });
    first.session.change("offline then reload");
    first.session.dispose();

    const online = { value: false };
    const second = setup({ drafts, online });
    expect(second.session.getSnapshot()).toMatchObject({ content: "offline then reload", state: "offline", restored: true });
    second.session.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.server.calls).toHaveLength(0);
    online.value = true;
    second.session.online();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.server.current.content).toBe("offline then reload");
    expect(drafts.entries.has("n1")).toBe(false);
  });
});

describe("NoteAutosave: adopting a version from outside", () => {
  it("takes a newer version (a rename) while clean, ignores it while text is unsaved", async () => {
    const { session } = setup();
    session.adopt({ id: "n1", revision: 2, content: NOTE.content });
    expect(session.getSnapshot().note.revision).toBe(2);
    session.change("typing");
    session.adopt({ id: "n1", revision: 3, content: "other" });
    expect(session.getSnapshot()).toMatchObject({ content: "typing" });
    expect(session.getSnapshot().note.revision).toBe(2);
  });
});

describe("NoteSessions", () => {
  it("keeps a session with unsaved text after its editor goes away and hands it back on reopen", async () => {
    const sessions = new NoteSessions();
    const server = fakeServer(NOTE);
    server.script.push("network");
    const drafts = memoryDraftStore();
    const first = sessions.open({ note: NOTE, store: server.store, drafts, isOnline: () => true });
    first.change("unsaved");
    sessions.release(first);
    await vi.advanceTimersByTimeAsync(0);
    const again = sessions.open({ note: NOTE, store: server.store, drafts });
    expect(again).toBe(first);
    expect(again.getSnapshot().content).toBe("unsaved");
  });

  it("drops a clean session on release", async () => {
    const sessions = new NoteSessions();
    const server = fakeServer(NOTE);
    const first = sessions.open({ note: NOTE, store: server.store, drafts: memoryDraftStore() });
    sessions.release(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.get("n1")).toBeUndefined();
  });
});
