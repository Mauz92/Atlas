# Atlas — Markdown Storage and Integrity

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-11-03 (section 4a: history and merge, SYNC-04)

Markdown portability is a core requirement, not an export option. Note content lives only in
real files; Atlas must never be required to read them.

---

## 1. Directory Layout

A configurable root is mounted into the container:

```
/data/atlas/
  notes/
    Inbox/
    daily/        (YYYY-MM-DD.md, created on demand, ADR-0049)
    templates/    (notes offered when creating a note, ADR-0049)
    Projects/
    Areas/
    Resources/
    Archive/
  exports/
  backups/
```

- The user may reorganise folders freely; Atlas follows the filesystem.
- Nothing outside the configured notes root is ever read, written or deleted.
- Atlas keeps its own state in a reserved hidden directory, `<notes-root>/.atlas`: `.atlas/trash` (deleted notes) and
  `.atlas/history/<note_id>/<sha256>.md` (retained revisions, SYNC-04, section 4a). It is excluded from listings, rejected by the
  path validator for user operations, included in every backup, and safe to ignore in an external editor.

## 2. File Format

- Standard **UTF-8** Markdown.
- Supported: headings, lists, checklists, tables, fenced code, relative links, `[[wiki links]]`,
  tags, optional YAML frontmatter, relative-path attachments.
- Frontmatter is optional; no template is required to write.
- No proprietary formats; no custom extensions that break external editors.

## 3. Safe File Operations

The storage layer must:

- **Validate paths** — resolve against the root and reject anything escaping it (`..`, absolute
  paths, encoded traversal).
- **Refuse to follow symlinks** that resolve outside the notes root.
- **Write atomically** — write to a temp file in the same directory, `fsync`, then rename.
- **Create without overwriting** — a new note is published with a hard link of the fsynced temp file
  (`NotesStorage.write_new`), which fails if the path exists, so concurrent creators and a file added by
  an editor are never replaced (ADR-0049). Daily-note creation is also serialised per path and adopts an
  existing unindexed file instead of writing.
- **Track revisions** — a revision identifier and/or content hash (e.g. SHA-256 of bytes).
- **Detect stale writes** — compare the client's base revision to the current revision.
- **Preserve conflicts** — never silently overwrite.
- **Handle renames** — update metadata while keeping stable note ids so links survive.

## 4. Concurrency and Conflicts

Use **optimistic concurrency control**:

1. Client sends the revision it based its edit on.
2. If the current revision matches, apply the write atomically and bump the revision.
3. If it does not match, return `409 Conflict` with the current revision.
4. The client offers a merge; if a safe merge is impossible, **both versions are preserved**
   (a conflict copy is written next to the note, clearly named) and the UI explains how to
   resolve it.

Silent last-write-wins is prohibited for Markdown.

**Autosave clients (ADR-0054).** A client saves by itself, so it must: send every change with its
`base_revision`; send one request at a time per note; keep unsent text in a local draft until the server
confirms exactly that text; on `409` stop sending, keep the text and offer *keep as a conflict copy* /
*reload*; after a request whose outcome is unknown (the `PUT` has no idempotency key) re-send the same body and,
if that answers `409`, re-read the note and treat it as saved only when the server's text equals the text sent;
and call `POST /api/notes/reconcile` before reading the server's version to resolve a conflict, because an edit
made on disk is only visible to the revision check once indexed (§5).

### 4a. Note history and the three-way merge (SYNC-04, ADR-0059 D5, ADR-0060)

Sync clients (`Atlas-Sync: 1`) edit offline, so a save can be based on a revision that is no longer current. The server merges
instead of refusing, but only when it can prove the result:

- **History.** Every revision of every note is recorded in `note_revisions` (revision, hash, size, path, reason) and its text is
  written to `.atlas/history/<note_id>/<sha256>.md` (atomic write; the file name is the hash of its bytes, so a revision whose
  text did not change - a move, a delete - shares its neighbour's file, and a file that no longer hashes to its name is never
  used). Retention: the newest 20 revisions; older ones while younger than 90 days, bounded by 200 revisions and 64 MiB of
  distinct text per note (`NOTE_HISTORY_*`); the history of a note deleted for 90 days is removed. A revision that was pruned is
  *unavailable*, and an unavailable base is a conflict, never a guess.
- **`merge3(base, theirs, ours)`** (`atlas/notes/merge.py`): line based like `diff3`. Lines are split on `\n` only and keep their
  own terminator, so CRLF, LF and mixed files keep every line ending exactly; the final newline is merged separately (appending a
  line to a note without a trailing newline merges with an edit above it). Regions between lines both sides kept are decided
  independently: one side changed it, or both made the identical change ⇒ merged; anything else (including two edits that touch)
  ⇒ conflict. The front-matter block of the result must be byte-identical to one side's, the result must fit `MAX_NOTE_BYTES`, and
  inputs beyond 200 000 lines or 4 000 000 diff cells are not merged. UTF-8 text, a BOM and lone `\r` pass through untouched.
- **Conflict copy.** A write that cannot be merged leaves the note untouched and is saved as
  `<name> (conflict YYYY-MM-DD HHMMSS).md` (a second one in the same second gets ` 2`), a normal note on every device. Silent
  last-write-wins stays prohibited.
- **Edit versus delete.** A stale delete is refused (the edit wins); an edit of a deleted note brings it back, merged into its last
  text (the delete moved the file to `.atlas/trash`, its text is also in history).
- **Portable paths** (sync mode only, `atlas/notes/portable.py`): see `SYNC_PROTOCOL.md` section 11.

## 5. External Editing and Reconciliation (ADR-0010)

- The filesystem is authoritative. Files edited outside Atlas are legitimate.
- A **periodic hash-based scan** is the reliable reconciliation mechanism. It runs as the
  `notes.reconcile` worker job (interval: `NOTES_RECONCILE_SECONDS`, default 300) and can be
  triggered on demand with `POST /api/notes/reconcile`.
- The scan re-indexes added, changed and removed files and restores a note that reappears.
- **Filesystem notifications (fsnotify) are an optimisation only** — they may be missed and are
  never the sole detection method.
- On detecting an external change, Atlas refreshes metadata and revision. If the note is open in
  an editor, the change is surfaced as a conflict rather than force-applied.
- Direct filesystem edits do **not** automatically propagate to other devices; propagation
  happens through the sync layer once Atlas has reconciled the file.

## 6. Deletion

- Deleting a note moves the file to `<notes-root>/.atlas/trash/<timestamp>/<name>` and records a
  tombstone (`notes.deleted_at`). The file is never removed with `rm`.
- A file reappearing at the same path (for example restored from the trash by hand) is picked up by
  reconciliation and becomes live again.
- Atlas never deletes files outside the notes directory.
- Tombstones prevent offline clients from resurrecting deleted notes.

## 7. Search and Metadata Index

- PostgreSQL holds note **metadata only**: relative path, title, content hash, revision, size,
  timestamps, and derived tags/links.
- Full-text search uses PostgreSQL FTS over the indexed content, refreshed on reconciliation.
- If the index and the file disagree, **the file wins**; the index is rebuilt from disk.

## 8. Rendering Safety

- Note content is untrusted input.
- Rendered preview sanitises HTML; raw HTML is escaped rather than executed.
- No script execution, no arbitrary embedded content.
- See `SECURITY.md` (T3, T6).

## 9. Tests Required

- Atomic write under interruption.
- Path traversal and symlink escape attempts rejected.
- Unicode and special-character round-trips.
- Concurrent edit produces a conflict, not data loss; both versions recoverable.
- External edit detected by scan and reflected in metadata.
- Rename preserves links.
- Delete is recoverable and produces a tombstone.
- Every revision is recorded with its exact bytes (CRLF included); a merge keeps line endings and the final newline;
  overlapping edits never overwrite and are kept whole in a conflict copy; a pruned or damaged merge base is a conflict; history
  never crosses users (`tests/integration/test_note_sync_merge.py`, `test_note_history.py`, `tests/unit/test_note_merge.py`).
