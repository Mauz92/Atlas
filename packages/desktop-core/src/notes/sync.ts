import { checkPortable, normalizeNotePath } from "../../../sync-core/src/index.ts";
import type { EntityView } from "../../../sync-core/src/index.ts";
import type { CryptoPort, FolderEntry, NotesFolderPort, RowDb } from "../ports.ts";

/** The part of the sync engine the folder engine drives (a `SyncEngine` satisfies it). */
export interface NotesEngine {
  views(): Promise<EntityView[]>;
  /** `lastSyncAt` is `null` until the first pull has completed. */
  getStatus(): Promise<{ lastSyncAt: number | null }>;
  createNote(path: string, content: string, id?: string): Promise<string>;
  editNote(id: string, text: string, base?: { revision: number; hash: string; text: string }): Promise<void>;
  moveNote(id: string, path: string): Promise<void>;
  deleteEntity(type: "note", id: string): Promise<void>;
}

/** What the folder engine knows about one note's file: where it is and what it held when last in step. */
export interface IndexEntry {
  id: string;
  path: string;
  /** SHA-256 of the file bytes when the file and the engine's text last agreed. */
  hash: string;
  /**
   * The server revision and text the file's content derives from (set when the file was written from, or found
   * equal to, a server revision). An external edit is sent against THIS base, so a newer server revision is merged
   * by the server instead of being overwritten.
   */
  base?: { revision: number; text: string };
}

export type SkipReason = "not_portable" | "too_large" | "invalid_utf8" | "error";
export interface SkippedFile {
  path: string;
  reason: SkipReason;
  detail: string;
}

export interface NotesSyncReport {
  root: string | null;
  running: boolean;
  lastScanAt: number | null;
  lastError: string | null;
  skipped: SkippedFile[];
  /** Counters since start (for tests and the diagnostics screen). */
  counts: { created: number; edited: number; moved: number; deleted: number; written: number; renamed: number; trashed: number; adopted: number; localCopies: number };
}

const TABLE = "notes_index" as const;

function withBase(entry: IndexEntry, base: IndexEntry["base"]): IndexEntry {
  const { base: _old, ...rest } = entry;
  void _old;
  return base ? { ...rest, base } : rest;
}

/**
 * The notes-folder engine (SYNC-09b; SYNC_PROTOCOL section 11; ADR-0069).
 *
 * The folder is NOT a second source of truth: the sync-core engine owns the note text and its
 * revisions, and this class only translates between files and engine calls. `reconcile()` is the
 * single entry point, serialised, idempotent, and safe to run at any time and any number of times
 * (watcher events are hints, the scan on start, on focus and every few minutes is the safety net):
 *
 *  A. files -> engine: a file whose hash differs from the index is an external edit (`editNote`,
 *     which keeps the base revision/hash so the server three-way merges or saves a conflict copy);
 *     a new file is a `createNote`, a missing file whose hash reappears elsewhere is a `moveNote`,
 *     a missing file is a delete (recoverable on the server, edit wins over delete).
 *  B. engine -> files: a note without a file is written; a note whose text changed is written only if
 *     the file still has the hash the index holds (compare-and-swap in the host, repeated right before
 *     the rename); a note deleted elsewhere moves its unchanged file to `.atlas-trash/`.
 *
 * A crash between the engine call and the index update is harmless: the next pass sees the same
 * difference and finds the engine already agrees (the check against the engine's text turns it into
 * an index update, not a second edit).
 */
export class NotesFolderSync {
  private index = new Map<string, IndexEntry>();
  private loaded = false;
  private chain: Promise<unknown> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private debounceCancel: (() => void) | null = null;
  private report: NotesSyncReport = {
    root: null,
    running: false,
    lastScanAt: null,
    lastError: null,
    skipped: [],
    counts: { created: 0, edited: 0, moved: 0, deleted: 0, written: 0, renamed: 0, trashed: 0, adopted: 0, localCopies: 0 },
  };

  constructor(
    private readonly deps: {
      engine: NotesEngine;
      folder: NotesFolderPort;
      db: RowDb;
      crypto: Pick<CryptoPort, "sha256" | "uuid">;
      timers: { setTimeout(fn: () => void, ms: number): () => void; wallTime(): number };
      /** Called after a pass that changed the engine's queue, so the host can tick the engine. */
      onEngineChanged?: () => void;
      debounceMs?: number;
      /** Used in the name of a local copy: `note (local copy 2026-11-10).md`. */
      today?: () => string;
    },
  ) {}

  status(): NotesSyncReport {
    return { ...this.report, skipped: [...this.report.skipped], counts: { ...this.report.counts } };
  }

  /** Start watching: each hint schedules a (debounced) reconcile. */
  start(): void {
    this.report.running = true;
    this.unsubscribe ??= this.deps.folder.onChange(() => this.hint());
  }

  stop(): void {
    this.report.running = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.debounceCancel?.();
    this.debounceCancel = null;
  }

  /** A watcher event, a pull or a wake-up: reconcile soon (many hints become one pass). */
  hint(): void {
    if (this.debounceCancel) return;
    this.debounceCancel = this.deps.timers.setTimeout(() => {
      this.debounceCancel = null;
      void this.reconcile(false);
    }, this.deps.debounceMs ?? 300);
  }

  /** Run one pass after the one in progress. `full`: hash every file (start, focus, periodic). */
  reconcile(full: boolean): Promise<void> {
    const run = this.chain.then(() => this.pass(full));
    this.chain = run.catch(() => undefined);
    return run;
  }

  // --- the index ------------------------------------------------------------------------------

  private async load(): Promise<void> {
    if (this.loaded) return;
    for (const raw of await this.deps.db.list(TABLE)) {
      const entry = JSON.parse(raw) as IndexEntry;
      this.index.set(entry.id, entry);
    }
    this.loaded = true;
  }

  private async setIndex(entry: IndexEntry): Promise<void> {
    this.index.set(entry.id, entry);
    await this.deps.db.commit([{ op: "put", table: TABLE, key: entry.id, value: JSON.stringify(entry) }]);
  }

  private async dropIndex(id: string): Promise<void> {
    this.index.delete(id);
    await this.deps.db.commit([{ op: "del", table: TABLE, key: id }]);
  }

  // --- one pass -------------------------------------------------------------------------------

  private async pass(full: boolean): Promise<void> {
    const { folder } = this.deps;
    await this.load();
    const root = await folder.root();
    this.report.root = root;
    if (root === null) return;
    let entries: FolderEntry[];
    try {
      entries = await folder.scan(full);
    } catch (e) {
      // `root_missing` (a drive that is not mounted) must never look like "every file was deleted".
      this.report.lastError = e instanceof Error ? e.message : String(e);
      return;
    }
    this.report.lastError = null;
    // Before the first pull the engine does not know the server's notes: creating or deleting now would duplicate
    // (collision renames) or misjudge them. The scan runs, the translation waits.
    if ((await this.deps.engine.getStatus()).lastSyncAt === null) {
      this.report.lastScanAt = this.deps.timers.wallTime();
      return;
    }
    this.report.lastScanAt = this.deps.timers.wallTime();
    const skipped: SkippedFile[] = [];
    const files = new Map<string, FolderEntry>();
    for (const entry of entries) {
      if (entry.status !== "ok") {
        skipped.push({ path: entry.path, reason: entry.status, detail: entry.status === "too_large" ? "larger than 5 MiB" : "not valid UTF-8" });
        continue;
      }
      const problem = checkPortable(entry.path);
      if (problem) {
        skipped.push({ path: entry.path, reason: "not_portable", detail: problem.detail });
        continue;
      }
      files.set(entry.path, entry);
    }
    // Files that exist but cannot be synced count as "present", so their notes are not seen as deleted.
    const present = new Set(entries.map((e) => e.path));

    let changed = false;
    try {
      changed = (await this.filesToEngine(files, present, skipped)) || changed;
      changed = (await this.engineToFiles(files, skipped)) || changed;
    } finally {
      this.report.skipped = skipped;
    }
    if (changed) this.deps.onEngineChanged?.();
  }

  /** The base to remember when a file and a server revision agree (only when no local edit is pending on the note). */
  private baseOf(view: EntityView): IndexEntry["base"] {
    return view.pendingOps === 0 && view.serverRevision !== null && view.content !== null ? { revision: view.serverRevision, text: view.content } : undefined;
  }

  private noteViews(all: EntityView[]): Map<string, EntityView> {
    return new Map(all.filter((v) => v.type === "note").map((v) => [v.id, v]));
  }

  private async textHash(view: EntityView): Promise<string | null> {
    return view.content === null ? null : this.deps.crypto.sha256(view.content);
  }

  /** A. External changes become engine operations. Returns true when the engine's queue changed. */
  private async filesToEngine(files: Map<string, FolderEntry>, present: Set<string>, skipped: SkippedFile[]): Promise<boolean> {
    const { engine, folder } = this.deps;
    let changed = false;
    const views = this.noteViews(await engine.views());
    const byPath = new Map<string, IndexEntry>([...this.index.values()].map((e) => [e.path, e]));
    // Index entries whose file is gone, by hash: candidates for a rename.
    const gone = [...this.index.values()].filter((e) => !present.has(e.path) && views.get(e.id) && !views.get(e.id)!.deleted);
    const goneByHash = new Map<string, IndexEntry[]>();
    for (const e of gone) goneByHash.set(e.hash, [...(goneByHash.get(e.hash) ?? []), e]);
    const consumed = new Set<string>();

    for (const [path, file] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      try {
        const known = byPath.get(path);
        if (known) {
          if (known.hash === file.hash) continue;
          const view = views.get(known.id);
          if (!view || view.deleted) continue; // step B handles a note deleted elsewhere
          const engineHash = await this.textHash(view);
          if (engineHash === null) continue; // the text is not downloaded yet: nothing to compare with
          if (engineHash === file.hash) {
            await this.setIndex(withBase({ ...known, hash: file.hash }, this.baseOf(view))); // already in step (crash window, or a write of ours)
            continue;
          }
          const text = await folder.read(path);
          // The file derives from `known.base`; if the engine has moved on, say so (the server merges, it does not overwrite).
          const stale = known.base !== undefined && view.pendingOps === 0 && view.serverRevision !== known.base.revision;
          await engine.editNote(known.id, text, stale ? { revision: known.base!.revision, hash: await this.deps.crypto.sha256(known.base!.text), text: known.base!.text } : undefined);
          await this.setIndex({ ...known, hash: file.hash });
          this.report.counts.edited++;
          changed = true;
          continue;
        }
        // A file the index does not know.
        const candidates = (goneByHash.get(file.hash) ?? []).filter((c) => !consumed.has(c.id));
        if (candidates.length === 1) {
          const from = candidates[0]!;
          consumed.add(from.id);
          await engine.moveNote(from.id, path);
          await this.setIndex({ id: from.id, path, hash: file.hash });
          this.report.counts.moved++;
          changed = true;
          continue;
        }
        // A note of the engine already lives at this path (first run in a folder that has the same notes, or a race).
        const sameName = [...views.values()].find((v) => !v.deleted && v.fields["path"] === path && !this.index.has(v.id));
        const text = await folder.read(path);
        if (sameName) {
          const theirs = await this.textHash(sameName);
          if (theirs === null) continue; // wait until its text has been downloaded
          if (theirs === file.hash) {
            await this.setIndex(withBase({ id: sameName.id, path, hash: file.hash }, this.baseOf(sameName)));
            this.report.counts.adopted++;
            continue;
          }
          // Two different texts for one name: keep BOTH. The local text becomes a note of its own next to the original.
          const copyPath = await this.freeName(path, files, views);
          const id = await engine.createNote(copyPath, text);
          const written = await folder.write(copyPath, text, null);
          if (written.result === "written") await this.setIndex({ id, path: copyPath, hash: written.hash });
          // the original name now follows the engine (step B overwrites it with the synced text if the file still has this hash)
          await this.setIndex(withBase({ id: sameName.id, path, hash: file.hash }, this.baseOf(sameName)));
          this.report.counts.localCopies++;
          changed = true;
          continue;
        }
        const id = await engine.createNote(path, text);
        await this.setIndex({ id, path, hash: file.hash });
        this.report.counts.created++;
        changed = true;
      } catch (e) {
        skipped.push({ path, reason: "error", detail: e instanceof Error ? e.message : String(e) });
      }
    }

    // Files that disappeared (and were not renames): a delete. The server keeps the note recoverable.
    for (const entry of gone) {
      if (consumed.has(entry.id) || present.has(entry.path)) continue;
      try {
        await engine.deleteEntity("note", entry.id);
        await this.dropIndex(entry.id);
        this.report.counts.deleted++;
        changed = true;
      } catch (e) {
        skipped.push({ path: entry.path, reason: "error", detail: e instanceof Error ? e.message : String(e) });
      }
    }
    return changed;
  }

  private async freeName(path: string, files: Map<string, FolderEntry>, views: Map<string, EntityView>): Promise<string> {
    const taken = new Set([...files.keys(), ...[...views.values()].filter((v) => !v.deleted).map((v) => String(v.fields["path"]))]);
    const stem = path.replace(/\.md$/i, "");
    const day = this.deps.today?.() ?? new Date(this.deps.timers.wallTime()).toISOString().slice(0, 10);
    for (let n = 0; ; n++) {
      const candidate = normalizeNotePath(`${stem} (local copy ${day}${n ? ` ${n + 1}` : ""}).md`);
      if (!taken.has(candidate) && !checkPortable(candidate)) return candidate;
    }
  }

  /** B. The engine's notes become files. Returns true when anything was written (the engine is unchanged). */
  private async engineToFiles(files: Map<string, FolderEntry>, skipped: SkippedFile[]): Promise<boolean> {
    const { engine, folder } = this.deps;
    const views = this.noteViews(await engine.views());
    // The files as step A left them: an index update changes what the folder is expected to hold.
    const hashAt = (path: string) => files.get(path)?.hash;

    for (const view of [...views.values()].sort((a, b) => (String(a.fields["path"]) < String(b.fields["path"]) ? -1 : 1))) {
      const entry = this.index.get(view.id);
      const wanted = typeof view.fields["path"] === "string" ? (view.fields["path"] as string) : null;
      try {
        if (view.deleted) {
          if (!entry) continue;
          const result = await folder.trash(entry.path, entry.hash);
          if (result === "trashed") this.report.counts.trashed++;
          // `changed`: the file was edited here after the delete: keep it, it becomes a new note on the next pass (edit wins).
          await this.dropIndex(view.id);
          continue;
        }
        if (wanted === null || view.content === null) continue;
        if (checkPortable(wanted)) {
          skipped.push({ path: wanted, reason: "not_portable", detail: "this note's path cannot be used as a file name on every platform" });
          continue;
        }
        const engineHash = await this.textHash(view);
        if (engineHash === null) continue;
        if (!entry) {
          const existing = hashAt(wanted);
          if (existing !== undefined) {
            if (existing === engineHash) await this.setIndex(withBase({ id: view.id, path: wanted, hash: existing }, this.baseOf(view)));
            continue; // a different file is in the way: step A of the next pass decides (adopt or keep both)
          }
          const written = await folder.write(wanted, view.content, null);
          if (written.result === "written") {
            await this.setIndex(withBase({ id: view.id, path: wanted, hash: written.hash }, this.baseOf(view)));
            this.report.counts.written++;
          }
          continue;
        }
        if (entry.path !== wanted) {
          const moved = await folder.rename(entry.path, wanted, entry.hash);
          if (moved === "renamed") {
            await this.setIndex({ ...entry, path: wanted });
            this.report.counts.renamed++;
          } else if (moved === "missing") await this.dropIndex(view.id);
          continue;
        }
        if (entry.hash === engineHash) {
          // in step: remember which server revision the file now matches (the base of its next external edit)
          const base = this.baseOf(view);
          if (base && entry.base?.revision !== base.revision) await this.setIndex(withBase(entry, base));
          continue;
        }
        const current = hashAt(entry.path);
        if (current !== undefined && current !== entry.hash) continue; // edited locally meanwhile: step A takes it next pass
        const written = await folder.write(entry.path, view.content, entry.hash);
        if (written.result === "written") {
          await this.setIndex(withBase({ ...entry, hash: written.hash }, this.baseOf(view)));
          this.report.counts.written++;
        }
      } catch (e) {
        skipped.push({ path: wanted ?? view.id, reason: "error", detail: e instanceof Error ? e.message : String(e) });
      }
    }
    // An index entry for a note the engine no longer has at all (a snapshot resync dropped it): same as deleted elsewhere.
    for (const entry of [...this.index.values()]) {
      if (views.has(entry.id)) continue;
      try {
        await folder.trash(entry.path, entry.hash);
        await this.dropIndex(entry.id);
      } catch (e) {
        skipped.push({ path: entry.path, reason: "error", detail: e instanceof Error ? e.message : String(e) });
      }
    }
    return false;
  }
}
