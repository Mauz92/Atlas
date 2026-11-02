import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { ApiError, notesApi, type NoteDetail, type NoteSummary } from "../api/client";
import { NoteEditor } from "../components/NoteEditor";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { NoteTree } from "../components/NoteTree";
import { buildTree } from "../lib/noteTree";

export function Notes() {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [selected, setSelected] = useState<NoteDetail | null>(null);
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NoteSummary[] | null>(null);
  const [newPath, setNewPath] = useState("");

  // `/notes?open=<id>` opens that note (the command palette and the Search page link here).
  const [params] = useSearchParams();
  const openId = params.get("open");

  const dirty = selected !== null && content !== selected.content;
  const tree = useMemo(() => buildTree(folders, notes), [folders, notes]);

  const refresh = useCallback(async () => {
    const listing = await notesApi.list();
    setNotes(listing.notes);
    setFolders(listing.folders);
  }, []);

  useEffect(() => {
    refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, [refresh]);

  async function openNote(id: string) {
    if (dirty && !window.confirm("Discard unsaved changes?")) {
      return;
    }
    setError(null);
    setStatus(null);
    setConflictRevision(null);
    try {
      const detail = await notesApi.get(id);
      setSelected(detail);
      setContent(detail.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open note");
    }
  }

  const openRequested = useRef(openNote);
  openRequested.current = openNote;
  useEffect(() => {
    if (openId) {
      void openRequested.current(openId);
    }
  }, [openId]);

  async function save() {
    if (!selected) {
      return;
    }
    setError(null);
    try {
      const updated = await notesApi.update(selected.id, content, selected.revision);
      setSelected(updated);
      setContent(updated.content);
      setConflictRevision(null);
      setStatus("Saved");
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflictRevision(err.currentRevision);
        setError("This note changed elsewhere. Choose how to resolve it.");
        return;
      }
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  async function saveAsConflictCopy() {
    if (!selected) {
      return;
    }
    try {
      const copy = await notesApi.saveConflictCopy(selected.id, content);
      setConflictRevision(null);
      setStatus(`Kept your version as “${copy.path}”`);
      await refresh();
      await openNote(selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not keep a conflict copy");
    }
  }

  async function reloadFromServer() {
    if (!selected) {
      return;
    }
    setConflictRevision(null);
    setStatus(null);
    await openNote(selected.id);
  }

  async function createNote() {
    const path = newPath.trim();
    if (!path) {
      return;
    }
    try {
      const created = await notesApi.create(path, `# ${path.split("/").pop()?.replace(/\.md$/, "")}\n`);
      setNewPath("");
      await refresh();
      setSelected(created);
      setContent(created.content);
      setStatus("Created");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the note");
    }
  }

  async function createFolder() {
    const path = newPath.trim();
    if (!path) {
      return;
    }
    try {
      await notesApi.createFolder(path);
      setNewPath("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the folder");
    }
  }

  async function renameSelected() {
    if (!selected) {
      return;
    }
    const target = window.prompt("New path", selected.path);
    if (!target || target === selected.path) {
      return;
    }
    try {
      const moved = await notesApi.move(selected.id, target);
      setSelected(moved);
      await refresh();
      setStatus("Renamed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed");
    }
  }

  async function deleteSelected() {
    if (!selected || !window.confirm(`Delete “${selected.path}”? It moves to the trash folder.`)) {
      return;
    }
    try {
      await notesApi.remove(selected.id);
      setSelected(null);
      setContent("");
      await refresh();
      setStatus("Moved to trash");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function runSearch(value: string) {
    setQuery(value);
    if (!value.trim()) {
      setResults(null);
      return;
    }
    try {
      setResults(await notesApi.search(value));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    }
  }

  return (
    <section className="page notes-page">
      <h1>Notes</h1>
      {error ? <p className="error">{error}</p> : null}
      {status ? <p className="muted">{status}</p> : null}

      <div className="notes-layout">
        <aside className="notes-sidebar">
          <input
            type="search"
            placeholder="Search notes"
            aria-label="Search notes"
            value={query}
            onChange={(event) => void runSearch(event.target.value)}
          />
          <div className="row">
            <input
              type="text"
              placeholder="Inbox/New note"
              aria-label="New note or folder path"
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
            />
            <button type="button" onClick={() => void createNote()}>
              New note
            </button>
            <button type="button" className="ghost" onClick={() => void createFolder()}>
              New folder
            </button>
          </div>
          {results ? (
            <div>
              <p className="muted">{results.length} result(s)</p>
              <ul className="tree">
                {results.map((note) => (
                  <li key={note.id}>
                    <button type="button" className="tree-note" onClick={() => void openNote(note.id)}>
                      {note.path}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <NoteTree
              tree={tree}
              selectedId={selected?.id ?? null}
              onSelect={(id) => void openNote(id)}
              onSelectFolder={(path) => setNewPath(`${path}/`)}
            />
          )}
        </aside>

        <div className="notes-main">
          {selected ? (
            <>
              <div className="notes-toolbar">
                <span className="muted">
                  {selected.path} · revision {selected.revision}
                  {dirty ? " · unsaved" : ""}
                </span>
                <div className="row">
                  <button type="button" onClick={() => void save()} disabled={!dirty}>
                    Save
                  </button>
                  <button type="button" className="ghost" onClick={() => void renameSelected()}>
                    Rename
                  </button>
                  <button type="button" className="ghost" onClick={() => void deleteSelected()}>
                    Delete
                  </button>
                </div>
              </div>

              {conflictRevision !== null ? (
                <div className="conflict-banner">
                  <span>The server has revision {conflictRevision}. Nothing was overwritten.</span>
                  <div className="row">
                    <button type="button" onClick={() => void saveAsConflictCopy()}>
                      Keep my version as a copy
                    </button>
                    <button type="button" className="ghost" onClick={() => void reloadFromServer()}>
                      Reload server version
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="editor-split">
                <NoteEditor value={content} onChange={setContent} />
                <MarkdownPreview content={content} />
              </div>

              {selected.tags.length > 0 ? (
                <p className="muted">Tags: {selected.tags.map((tag) => `#${tag}`).join(", ")}</p>
              ) : null}

              <div className="notes-links">
                <div>
                  <h2>Links</h2>
                  {selected.links.length === 0 ? (
                    <p className="muted">No wiki links.</p>
                  ) : (
                    <ul>
                      {selected.links.map((link) => (
                        <li key={link.target_path}>
                          {link.target_note_id ? (
                            <button
                              type="button"
                              className="link"
                              onClick={() => void openNote(link.target_note_id as string)}
                            >
                              {link.target_path}
                            </button>
                          ) : (
                            <span className="muted">{link.target_path} (unresolved)</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h2>Backlinks</h2>
                  {selected.backlinks.length === 0 ? (
                    <p className="muted">Nothing links here yet.</p>
                  ) : (
                    <ul>
                      {selected.backlinks.map((note) => (
                        <li key={note.id}>
                          <button type="button" className="link" onClick={() => void openNote(note.id)}>
                            {note.path}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state">Select a note, or create one to get started.</div>
          )}
        </div>
      </div>
    </section>
  );
}
