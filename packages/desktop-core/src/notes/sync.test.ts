import { SyncEngine } from "../../../sync-core/src/index.ts";
import { ModelServer } from "../../../sync-core/sim/model/server.ts";
import { createPortTransport } from "../transport.ts";
import { SqliteLocalStore } from "../sqliteStore.ts";
import { createFakePlatform, modelHttp, settle, sha256Hex, type FakePlatform } from "../testing/index.ts";
import { NotesFolderSync } from "./sync.ts";

/** One desktop: the real engine over the SQLite store, the folder engine over a fake folder, a shared model server. */
class Desktop {
  readonly p: FakePlatform;
  engine!: SyncEngine;
  notes!: NotesFolderSync;
  constructor(readonly server: ModelServer, readonly name: string) {
    this.p = createFakePlatform(name.charCodeAt(0) * 101);
    this.p.http = Object.assign(this.p.http, modelHttp(server));
    this.boot();
  }
  boot(): void {
    const p = this.p;
    this.engine?.dispose();
    this.engine = new SyncEngine({
      store: new SqliteLocalStore(p.db),
      transport: createPortTransport(modelHttp(this.server)),
      clock: p.timers,
      ids: p.crypto,
      random: { next: () => p.crypto.random() },
    });
    this.notes = new NotesFolderSync({ engine: this.engine, folder: p.folder, db: p.db, crypto: p.crypto, timers: p.timers, today: () => "2026-11-10" });
  }
  /** Settle the engine and the folder with each other until nothing changes (what the watcher and the pull loop do over time). */
  async settle(rounds = 8): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await this.notes.reconcile(true);
      this.engine.requestPull();
      await this.engine.syncUntilSettled();
      await settle(3);
    }
  }
  files(): Record<string, string> {
    return Object.fromEntries([...this.p.folder.files].map(([k, v]) => [k, v.content]));
  }
}

const notePaths = (d: Desktop) => Object.keys(d.files()).sort();

describe("notes folder engine (real engine, model server, fake folder)", () => {
  it("an external new file becomes a note on the server and a file on a second desktop", async () => {
    const server = new ModelServer();
    const a = new Desktop(server, "A");
    const b = new Desktop(server, "B");
    a.p.folder.put("ideas/first.md", "# First\nhello\n");
    await a.settle();
    await b.settle();
    expect(b.files()).toEqual({ "ideas/first.md": "# First\nhello\n" });
    expect(a.notes.status().counts.created).toBe(1);
  });

  it("an external edit is a base-hashed edit: the server merges it with a concurrent edit from the other device", async () => {
    const server = new ModelServer();
    const a = new Desktop(server, "A");
    const b = new Desktop(server, "B");
    a.p.folder.put("m.md", "one\ntwo\nthree\nfour\nfive\n");
    await a.settle();
    await b.settle();
    // both edit different lines while apart
    a.p.folder.put("m.md", "ONE\ntwo\nthree\nfour\nfive\n");
    b.p.folder.put("m.md", "one\ntwo\nthree\nfour\nFIVE\n");
    await a.settle();
    await b.settle();
    await a.settle();
    expect(a.files()["m.md"]).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
    expect(b.files()["m.md"]).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
  });

  it("a real conflict keeps BOTH texts: the server's version in the file, the loser as a conflict-copy file", async () => {
    const server = new ModelServer();
    const a = new Desktop(server, "A");
    const b = new Desktop(server, "B");
    a.p.folder.put("c.md", "shared line\n");
    await a.settle();
    await b.settle();
    a.p.folder.put("c.md", "A says this\n");
    b.p.folder.put("c.md", "B says that\n");
    await a.settle();
    await b.settle();
    await a.settle();
    await b.settle();
    const texts = [...Object.values(a.files())].sort();
    expect(texts).toContain("A says this\n");
    expect(texts).toContain("B says that\n");
    expect(notePaths(a).length).toBe(2); // the note and one conflict copy
    expect(a.files()).toEqual(b.files());
    expect(notePaths(a).some((p) => /conflict/i.test(p))).toBe(true);
  });

  it("a file deleted locally is deleted on the server and moved to the other device's trash; a rename is a move", async () => {
    const server = new ModelServer();
    const a = new Desktop(server, "A");
    const b = new Desktop(server, "B");
    a.p.folder.put("old.md", "keep me\n");
    a.p.folder.put("gone.md", "bye\n");
    await a.settle();
    await b.settle();
    a.p.folder.move("old.md", "new name.md");
    a.p.folder.remove("gone.md");
    await a.settle();
    await b.settle();
    expect(b.files()).toEqual({ "new name.md": "keep me\n" });
    expect(b.p.folder.trashed.map((t) => t.content)).toEqual(["bye\n"]);
    expect(a.notes.status().counts.moved).toBe(1);
  });

  it("a server write never overwrites a file the user edited in the meantime (compare-and-swap)", async () => {
    const server = new ModelServer();
    const a = new Desktop(server, "A");
    const b = new Desktop(server, "B");
    a.p.folder.put("race.md", "v1\n");
    await a.settle();
    await b.settle();
    b.p.folder.put("race.md", "v2 from B\n");
    await b.settle();
    // A is about to receive v2, but the user types into the file at that very moment
    a.p.folder.beforeApply = (path) => {
      a.p.folder.beforeApply = null;
      a.p.folder.files.set(path, { content: "v1 plus local words\n", mtimeMs: 99 });
    };
    await a.settle();
    await b.settle();
    await a.settle();
    // nothing was lost: both v2 and the local words survive somewhere
    const all = Object.values(a.files()).join("|");
    expect(all).toContain("v2 from B");
    expect(all).toContain("local words");
  });

  it("a same-size edit with an unchanged mtime is found by the full scan", async () => {
    const server = new ModelServer();
    const a = new Desktop(server, "A");
    a.p.folder.put("s.md", "aaaa\n");
    await a.settle();
    a.p.folder.files.set("s.md", { content: "bbbb\n", mtimeMs: a.p.folder.files.get("s.md")!.mtimeMs });
    await a.settle();
    const b = new Desktop(server, "B");
    await b.settle();
    expect(b.files()["s.md"]).toBe("bbbb\n");
  });

  it("a crash between the engine call and the index update does not create a second edit", async () => {
    const server = new ModelServer();
    const a = new Desktop(server, "A");
    a.p.folder.put("x.md", "one\n");
    await a.settle();
    a.p.folder.put("x.md", "two\n");
    // the engine call happens, then the process dies before the index row is written
    const commit = a.p.db.commit.bind(a.p.db);
    let died = false;
    a.p.db.commit = async (ops) => {
      if (!died && ops.some((o) => o.table === "notes_index")) {
        died = true;
        throw new Error("killed");
      }
      return commit(ops);
    };
    await a.notes.reconcile(true).catch(() => undefined);
    expect(died).toBe(true);
    a.boot(); // restart: new engine and folder engine over the same database
    await a.settle();
    const ops = (await a.engine.getStatus()).pending;
    expect(ops).toBe(0);
    const b = new Desktop(server, "B");
    await b.settle();
    expect(b.files()).toEqual({ "x.md": "two\n" });
  });

  it("a missing folder is never read as 'everything was deleted'", async () => {
    const server = new ModelServer();
    const a = new Desktop(server, "A");
    a.p.folder.put("k.md", "keep\n");
    await a.settle();
    a.p.folder.missing = true;
    await a.settle();
    expect(a.notes.status().lastError).toBe("root_missing");
    expect(a.notes.status().counts.deleted).toBe(0);
    a.p.folder.missing = false;
    await a.settle();
    const b = new Desktop(server, "B");
    await b.settle();
    expect(b.files()).toEqual({ "k.md": "keep\n" });
  });

  it("files that cannot be synced are reported and left alone (too large, not UTF-8, not portable)", async () => {
    const server = new ModelServer();
    const a = new Desktop(server, "A");
    a.p.folder.extra = [
      { path: "huge.md", size: 6_000_000, mtimeMs: 1, hash: "", status: "too_large" },
      { path: "latin1.md", size: 3, mtimeMs: 1, hash: "x", status: "invalid_utf8" },
    ];
    a.p.folder.put("CON.md", "reserved on Windows\n");
    a.p.folder.put("fine.md", "ok\n");
    await a.settle();
    const skipped = a.notes.status().skipped;
    expect(skipped.map((s) => `${s.path}:${s.reason}`).sort()).toEqual(["CON.md:not_portable", "huge.md:too_large", "latin1.md:invalid_utf8"]);
    const b = new Desktop(server, "B");
    await b.settle();
    expect(b.files()).toEqual({ "fine.md": "ok\n" });
  });

  it("the same notes already present on both sides are adopted; different texts under one name are both kept", async () => {
    const server = new ModelServer();
    const a = new Desktop(server, "A");
    a.p.folder.put("same.md", "same\n");
    a.p.folder.put("diff.md", "server text\n");
    await a.settle();
    // a fresh device with a pre-filled folder (first run in an existing notes folder)
    const b = new Desktop(server, "B");
    b.p.folder.put("same.md", "same\n");
    b.p.folder.put("diff.md", "local text\n");
    await b.settle();
    await a.settle();
    expect(b.notes.status().counts.adopted).toBe(1);
    expect(b.notes.status().counts.localCopies).toBe(1);
    const texts = Object.values(b.files());
    expect(texts).toContain("server text\n");
    expect(texts).toContain("local text\n");
    expect(a.files()).toEqual(b.files());
  });

  it("content hashes are the server's: the index stores SHA-256 of the bytes", async () => {
    const server = new ModelServer();
    const a = new Desktop(server, "A");
    a.p.folder.put("h.md", "héllo wörld\n");
    await a.settle();
    const rows = [...a.p.db.dumpTable<{ hash: string }>("notes_index").values()];
    expect(rows.map((r) => r.hash)).toEqual([sha256Hex("héllo wörld\n")]);
  });
});
