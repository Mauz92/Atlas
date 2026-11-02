# Atlas — Markdown Storage and Integrity

**Status:** Draft for approval (Milestone 0)
**Last updated:** 2026-10-20

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
- Atlas keeps its own state in a reserved hidden directory, `<notes-root>/.atlas` (currently only
  `.atlas/trash`). It is excluded from listings, rejected by the path validator for user
  operations, and safe to ignore in an external editor.

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
