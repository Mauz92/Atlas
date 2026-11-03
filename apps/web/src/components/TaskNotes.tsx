import { useCallback, useEffect, useState } from "react";

import { tasksApi, type NoteSummary } from "../api/client";

interface TaskNotesProps {
  taskId: string;
  /** Open a note (the panel saves the task's edits first, then closes and navigates). */
  onOpen: (noteId: string) => void;
  openDisabled?: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

/**
 * The notes a task links to (MU-06), shown in the task detail. A link is made by "Task from
 * selection" in a note; here it can be followed or removed. Removing a link deletes neither the
 * task nor the note. The list is read from the server on every open, so a renamed note shows its
 * new path (the link holds the note's id).
 */
export function TaskNotes({ taskId, onOpen, openDisabled = false }: TaskNotesProps) {
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setNotes((await tasksApi.notes(taskId)).notes);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [taskId]);

  useEffect(() => {
    setNotes(null);
    setError(null);
    void load();
  }, [load]);

  async function unlink(note: NoteSummary) {
    setError(null);
    try {
      await tasksApi.unlinkNote(taskId, note.id);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className="task-notes" aria-label="Linked notes">
      <h3 className="task-section-title">Linked notes</h3>
      {notes !== null && notes.length === 0 ? (
        <p className="task-detail-hint">
          No linked notes. Select text in a note and choose “Task from selection”.
        </p>
      ) : null}
      {notes && notes.length > 0 ? (
        <ul>
          {notes.map((note) => (
            <li key={note.id}>
              <button
                type="button"
                className="link"
                disabled={openDisabled}
                aria-label={`Open note ${note.path}`}
                onClick={() => onOpen(note.id)}
              >
                {note.title || note.path}
              </button>{" "}
              <span className="muted task-note-path">{note.path}</span>{" "}
              <button
                type="button"
                className="ghost task-note-unlink"
                aria-label={`Unlink note ${note.path}`}
                onClick={() => void unlink(note)}
              >
                Unlink
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
