import { useCallback, useEffect, useState } from "react";

import { tasksApi, type Task } from "../api/client";
import { Icon } from "./Icon";

interface TaskSubtasksProps {
  parent: Task;
  /** Open a subtask in the detail panel (the panel saves the parent's edits first). */
  onOpen: (task: Task) => void;
  openDisabled?: boolean;
  /** Subtasks changed; lists showing the parent's "x/y" should refresh. */
  onChanged: () => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

/**
 * The subtask list of the task detail (MU-04): add, complete, open and remove, with the server's
 * own rollup shown as progress (it counts completed subtasks; the client does not re-derive it).
 * Subtasks are ordinary tasks, so completing and removing use the normal task endpoints.
 */
export function TaskSubtasks({
  parent,
  onOpen,
  openDisabled = false,
  onChanged,
}: TaskSubtasksProps) {
  const [subtasks, setSubtasks] = useState<Task[]>([]);
  const [rollup, setRollup] = useState({
    done: parent.subtasks_done,
    total: parent.subtasks_total,
  });
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parentId = parent.id;

  const load = useCallback(async () => {
    try {
      const [list, fresh] = await Promise.all([
        tasksApi.subtasks(parentId),
        tasksApi.get(parentId),
      ]);
      setSubtasks(list.tasks);
      setRollup({ done: fresh.subtasks_done, total: fresh.subtasks_total });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [parentId]);

  useEffect(() => {
    setSubtasks([]);
    setTitle("");
    setError(null);
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function add(event?: { preventDefault: () => void }) {
    event?.preventDefault();
    const text = title.trim();
    if (text === "") return;
    void run(async () => {
      await tasksApi.addSubtask(parentId, text);
      setTitle("");
    });
  }

  return (
    <section className="task-subtasks" aria-label="Subtasks">
      <h3 className="task-section-title">
        Subtasks
        {rollup.total > 0 ? (
          <span className="task-section-count">
            {rollup.done}/{rollup.total} done
          </span>
        ) : null}
      </h3>
      {rollup.total > 0 ? (
        <progress max={rollup.total} value={rollup.done} aria-label="Subtask progress" />
      ) : null}
      <ul className="task-subtask-list">
        {subtasks.map((sub) => (
          <li key={sub.id}>
            <input
              type="checkbox"
              className="task-check"
              aria-label={`Complete ${sub.title}`}
              checked={sub.status === "completed"}
              disabled={busy || sub.status === "completed"}
              onChange={() => void run(() => tasksApi.complete(sub))}
            />
            <button
              type="button"
              className={`task-subtask-title${sub.status === "completed" ? " done" : ""}`}
              aria-label={`Open subtask ${sub.title}`}
              disabled={openDisabled}
              onClick={() => onOpen(sub)}
            >
              {sub.title}
            </button>
            <button
              type="button"
              className="ghost icon-button task-subtask-remove"
              aria-label={`Remove ${sub.title}`}
              disabled={busy}
              onClick={() => void run(() => tasksApi.remove(sub))}
            >
              <Icon name="x" size={14} />
            </button>
          </li>
        ))}
      </ul>
      <div className="task-subtask-add">
        <input
          id={`${parentId}-new-subtask`}
          type="text"
          aria-label="New subtask"
          placeholder="Add a subtask…"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.stopPropagation();
              add(event);
            }
          }}
        />
        {title.trim() !== "" ? (
          <button type="button" className="ghost" onClick={add} disabled={busy}>
            Add subtask
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="task-prop-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
