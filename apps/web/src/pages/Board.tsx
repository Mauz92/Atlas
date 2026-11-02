import { Board } from "../components/Board";
import { LoadError } from "../components/LoadError";
import { useBoard } from "../hooks/useBoard";
import { useTaskEditor } from "../hooks/useTaskEditor";

/**
 * The global Kanban board (M4-03, ADR-0022). Columns are the task statuses and a task's column is
 * its status; dragging a card (or its menu's "Move to…") persists through `PATCH /api/tasks/{id}`.
 *
 * Placement: a single global board at `/board` rather than a per-project board, because no project
 * detail route exists yet; the presentational `Board` takes a `projectId`-scoped listing from
 * `useBoard`, so a project-scoped board can reuse it unchanged when the project view lands.
 */
export function BoardPage() {
  const {
    columns,
    tasksByStatus,
    total,
    state,
    error,
    actionError,
    movingId,
    timeZone,
    reload,
    refresh,
    move,
  } = useBoard();
  const editor = useTaskEditor({ refresh, timeZone });

  return (
    <section className="page board-page">
      <h1>Board</h1>
      <p className="muted">
        Drag a task between columns, or use “Move to…” in its menu, to change its status. Only
        the transitions Atlas allows are offered, and a rejected move is reported here.
      </p>

      {actionError || editor.error ? (
        <p className="error" role="alert">
          {actionError ?? editor.error}
        </p>
      ) : null}

      {state === "error" ? (
        <LoadError message={error} onRetry={() => void reload()} />
      ) : state === "loading" ? (
        <p className="muted" role="status">Loading board…</p>
      ) : (
        <Board
          columns={columns}
          tasksByStatus={tasksByStatus}
          timeZone={timeZone}
          onMove={(task, toStatus) => void move(task, toStatus)}
          onOpen={editor.open}
          movingId={movingId}
          empty={total === 0}
          actions={editor.actions}
        />
      )}
      {editor.overlays}
    </section>
  );
}
