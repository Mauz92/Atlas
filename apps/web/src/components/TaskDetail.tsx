import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import { TaskNotes } from "./TaskNotes";
import { TaskReminder } from "./TaskReminder";
import { TaskRepeat } from "./TaskRepeat";
import { TaskSubtasks } from "./TaskSubtasks";
import { formatDue, viewerTimeZone } from "../lib/tasks";
import {
  tasksApi,
  type Project,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "../api/client";
import { STATUS_LABELS, STATUS_ORDER, canMove } from "../lib/taskStatus";
import {
  PRIORITIES,
  changesFromDraft,
  recurrenceAnchor,
  draftFromTask,
  draftsEqual,
  type TaskDraft,
} from "../lib/taskForm";

interface TaskDetailProps {
  task: Task;
  /** The viewer's IANA zone, used to render the task's instants when it has no zone of its own. */
  timeZone?: string;
  /** Projects the task can be filed under (archived ones are offered only while the task is in one). */
  projects?: Project[];
  /** Close the panel (Esc and the Close button). */
  onClose: () => void;
  /** The task was saved; the lists should refresh. The panel stays open on the saved task. */
  onSaved: (task: Task) => void;
  /** The task was deleted; the owner of the panel offers the undo. */
  onDeleted: (task: Task) => void;
  /** Open another task (a subtask, the parent, the next occurrence) in this panel. */
  onOpenTask?: (task: Task) => void;
  /** Subtasks changed; the lists should refresh (the panel keeps its unsaved edits). */
  onRefresh?: () => void;
  /** Open a linked note (MU-06); the owner closes the panel and navigates. */
  onOpenNote?: (noteId: string) => void;
}

/** A 409 carrying the server's current revision means the task changed since it was read. */
function isRevisionConflict(err: unknown): boolean {
  const candidate = err as {
    status?: unknown;
    currentRevision?: unknown;
  } | null;
  return (
    candidate?.status === 409 && typeof candidate.currentRevision === "number"
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

/**
 * After completing a repeating task the server has created the next occurrence of the series (and
 * only that one). Find it by title and series; `null` with `checked` means the series has ended.
 */
async function findNextOccurrence(
  completed: Task,
): Promise<{ next: Task | null; checked: boolean }> {
  try {
    const head = completed.recurrence_parent_id ?? completed.id;
    const list = await tasksApi.list({
      q: completed.title.slice(0, 200),
      status: ["inbox", "next", "in_progress"],
      limit: 500,
    });
    const next =
      list.tasks
        .filter(
          (task) =>
            task.id !== completed.id &&
            (task.recurrence_parent_id ?? task.id) === head,
        )
        .sort(
          (a, b) =>
            Date.parse(a.due_at ?? a.start_at ?? "") -
            Date.parse(b.due_at ?? b.start_at ?? ""),
        )[0] ?? null;
    return { next, checked: true };
  } catch {
    return { next: null, checked: false };
  }
}

function supportedZones(): string[] {
  const intl = Intl as unknown as {
    supportedValuesOf?: (key: string) => string[];
  };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

/**
 * The single task detail surface (MU-01): a side sheet on wide screens and a full-screen page on
 * narrow ones (see `.task-detail` in `styles.css`). Every task list opens this same component.
 *
 * It only edits and relays: the form sends the minimal `PATCH` with the task's `base_revision`
 * (`lib/taskForm.ts`), the server validates every value and its message is shown verbatim, and a
 * stale edit shows a conflict instead of overwriting (the user chooses to load the latest). Esc
 * closes (asking first if there are unsaved edits); Ctrl/Cmd+Enter saves.
 */
export function TaskDetail({
  task,
  timeZone,
  projects = [],
  onClose,
  onSaved,
  onDeleted,
  onOpenTask,
  onRefresh,
  onOpenNote,
}: TaskDetailProps) {
  const ids = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState(task);
  const initial = useMemo(
    () => draftFromTask(current, timeZone),
    [current, timeZone],
  );
  const [draft, setDraft] = useState<TaskDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [completion, setCompletion] = useState<{
    next: Task | null;
    checked: boolean;
  } | null>(null);
  const zones = useMemo(supportedZones, []);

  const dirty = !draftsEqual(initial, draft);

  // A different task opened in the same panel starts from its own values.
  useEffect(() => {
    setCurrent(task);
    setDraft(draftFromTask(task, timeZone));
    setError(null);
    setConflict(false);
    setConfirmDiscard(false);
    setCompletion(null);
  }, [task, timeZone]);

  useEffect(() => {
    titleRef.current?.focus();
  }, [task.id]);

  function requestClose() {
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  // Esc closes from anywhere (the panel is a non-modal sheet, so focus may be in the list).
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        closeRef.current();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function set<K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setConfirmDiscard(false);
  }

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (busy) {
      return;
    }
    const changes = changesFromDraft(initial, draft, timeZone);
    if (Object.keys(changes).length === 0) {
      return;
    }
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      const saved = await tasksApi.update(current, changes);
      const completedRepeat =
        saved.status === "completed" &&
        current.status !== "completed" &&
        saved.recurrence_rule !== null;
      setCurrent(saved);
      setDraft(draftFromTask(saved, timeZone));
      setCompletion(null);
      if (completedRepeat) {
        // The server generated exactly the next occurrence; look it up so it can be shown.
        void findNextOccurrence(saved).then(setCompletion);
      }
      onSaved(saved);
    } catch (err) {
      if (isRevisionConflict(err)) {
        setConflict(true);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function loadLatest() {
    setBusy(true);
    setError(null);
    try {
      const latest = await tasksApi.get(current.id);
      setCurrent(latest);
      setDraft(draftFromTask(latest, timeZone));
      setConflict(false);
      onSaved(latest);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await tasksApi.remove(current);
      onDeleted(current);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const statusOptions = STATUS_ORDER.map((status) => ({
    status,
    // The server owns the transition rules; the form only steers away from moves it will refuse.
    disabled: status !== initial.status && !canMove(initial.status, status),
  }));

  return (
    <div
      className="task-detail"
      role="dialog"
      aria-label="Task details"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void save();
        }
      }}
    >
      <div className="task-detail-header">
        <h2>Task details</h2>
        <button type="button" className="ghost" onClick={requestClose}>
          Close
        </button>
      </div>

      <form className="task-detail-form" onSubmit={(event) => void save(event)}>
        <label htmlFor={`${ids}-title`}>Title</label>
        <input
          id={`${ids}-title`}
          ref={titleRef}
          type="text"
          value={draft.title}
          onChange={(event) => set("title", event.target.value)}
        />

        <label htmlFor={`${ids}-description`}>Description</label>
        <textarea
          id={`${ids}-description`}
          rows={4}
          value={draft.description}
          onChange={(event) => set("description", event.target.value)}
        />

        <div className="task-detail-row">
          <div>
            <label htmlFor={`${ids}-status`}>Status</label>
            <select
              id={`${ids}-status`}
              value={draft.status}
              onChange={(event) =>
                set("status", event.target.value as TaskStatus)
              }
            >
              {statusOptions.map(({ status, disabled }) => (
                <option key={status} value={status} disabled={disabled}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${ids}-priority`}>Priority</label>
            <select
              id={`${ids}-priority`}
              value={draft.priority}
              onChange={(event) =>
                set("priority", event.target.value as TaskPriority)
              }
            >
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {priority}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="task-detail-row">
          <div>
            <label htmlFor={`${ids}-due-date`}>Due date</label>
            <input
              id={`${ids}-due-date`}
              type="date"
              value={draft.dueDate}
              onChange={(event) => set("dueDate", event.target.value)}
            />
          </div>
          <div>
            <label htmlFor={`${ids}-due-time`}>Due time</label>
            <input
              id={`${ids}-due-time`}
              type="time"
              value={draft.dueTime}
              onChange={(event) => set("dueTime", event.target.value)}
            />
          </div>
        </div>
        <p className="muted task-detail-hint">
          Leave the time empty for the end of the day.
        </p>

        <label htmlFor={`${ids}-zone`}>Time zone</label>
        <input
          id={`${ids}-zone`}
          type="text"
          list={`${ids}-zones`}
          placeholder={
            timeZone ? `Default: ${timeZone}` : "e.g. Europe/Stockholm"
          }
          value={draft.timeZone}
          onChange={(event) => set("timeZone", event.target.value)}
        />
        <datalist id={`${ids}-zones`}>
          {zones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>

        <label htmlFor={`${ids}-start`}>Start</label>
        <input
          id={`${ids}-start`}
          type="datetime-local"
          value={draft.start}
          onChange={(event) => set("start", event.target.value)}
        />

        <TaskRepeat
          value={draft.recurrenceRule}
          onChange={(rule) => set("recurrenceRule", rule)}
          anchor={recurrenceAnchor(draft)}
          timeZone={draft.timeZone.trim() || timeZone || viewerTimeZone()}
          readOnly={current.recurrence_parent_id !== null}
        />

        <label htmlFor={`${ids}-project`}>Project</label>
        <select
          id={`${ids}-project`}
          value={draft.projectId}
          onChange={(event) => set("projectId", event.target.value)}
        >
          <option value="">No project</option>
          {projects
            .filter(
              (project) =>
                project.status !== "archived" ||
                project.id === initial.projectId,
            )
            .map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
                {project.status === "archived" ? " (archived)" : ""}
              </option>
            ))}
        </select>

        <label htmlFor={`${ids}-tags`}>Tags</label>
        <input
          id={`${ids}-tags`}
          type="text"
          placeholder="comma, separated"
          value={draft.tags}
          onChange={(event) => set("tags", event.target.value)}
        />

        {completion ? (
          <div className="task-detail-completion" role="status">
            {completion.next ? (
              <>
                <p>
                  Completed. Next occurrence:{" "}
                  {formatDue(
                    (completion.next.due_at ?? completion.next.start_at)!,
                    completion.next.time_zone ?? timeZone,
                  )}
                </p>
                {onOpenTask ? (
                  <button
                    type="button"
                    onClick={() => onOpenTask(completion.next!)}
                    disabled={dirty}
                  >
                    Open next occurrence
                  </button>
                ) : null}
              </>
            ) : completion.checked ? (
              <p>Completed. This was the last occurrence of the series.</p>
            ) : (
              <p>Completed. The next occurrence has been created.</p>
            )}
          </div>
        ) : null}

        {conflict ? (
          <div className="error task-detail-conflict" role="alert">
            <p>
              This task was changed somewhere else since you opened it. Your
              edits were not saved.
            </p>
            <button
              type="button"
              onClick={() => void loadLatest()}
              disabled={busy}
            >
              Load latest version
            </button>
          </div>
        ) : null}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {confirmDiscard ? (
          <div className="task-detail-discard" role="alert">
            <p>You have unsaved changes.</p>
            <button type="button" onClick={onClose}>
              Discard changes
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setConfirmDiscard(false)}
            >
              Keep editing
            </button>
          </div>
        ) : null}

        <div className="task-detail-actions">
          <button type="submit" className="primary" disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="ghost danger"
            onClick={() => void remove()}
            disabled={busy}
          >
            Delete
          </button>
        </div>
      </form>

      <div className="task-detail-sections">
        {current.parent_task_id && onOpenTask ? (
          <button
            type="button"
            className="ghost"
            disabled={dirty}
            onClick={() => {
              void tasksApi
                .get(current.parent_task_id!)
                .then(onOpenTask)
                .catch((err: unknown) => setError(errorMessage(err)));
            }}
          >
            Open parent task
          </button>
        ) : null}
        <TaskSubtasks
          parent={current}
          openDisabled={dirty || !onOpenTask}
          onOpen={(sub) => onOpenTask?.(sub)}
          onChanged={() => onRefresh?.()}
        />
        <TaskNotes
          taskId={current.id}
          openDisabled={dirty || !onOpenNote}
          onOpen={(noteId) => onOpenNote?.(noteId)}
        />
        <TaskReminder taskId={current.id} />
      </div>
    </div>
  );
}
