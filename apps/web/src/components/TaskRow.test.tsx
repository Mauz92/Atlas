import { fireEvent, render, screen, within } from "@testing-library/react";

import type { Task } from "../api/client";
import type { TaskActions } from "../hooks/useTaskActions";
import { menuItem } from "../test/menu";
import { makeProject, makeTask } from "../test/tasks";
import { TaskRow, type RowSelection } from "./TaskRow";

function makeActions(): TaskActions {
  return {
    toggleComplete: vi.fn(async () => {}),
    schedule: vi.fn(async () => {}),
    setPriority: vi.fn(async () => {}),
    moveToProject: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    busy: new Set(),
    error: null,
  };
}

const home = makeProject({ id: "p1", name: "Home" });

function renderRow(
  overrides: Partial<Task> = {},
  extra: { selection?: RowSelection; parentTitle?: string; actions?: TaskActions } = {},
) {
  const task = makeTask({ id: "a", title: "Pay rent", status: "next", ...overrides });
  const actions = extra.actions ?? makeActions();
  const onOpen = vi.fn();
  render(
    <ul>
      <TaskRow
        task={task}
        timeZone="UTC"
        project={task.project_id === "p1" ? home : undefined}
        parentTitle={extra.parentTitle}
        actions={actions}
        projects={[home]}
        onOpen={onOpen}
        selection={extra.selection}
      />
    </ul>,
  );
  return { task, actions, onOpen, row: screen.getByRole("listitem") };
}

describe("TaskRow", () => {
  it.each<[string, Partial<Task>, RegExp | string]>([
    ["a project", { project_id: "p1" }, "Home"],
    ["an overdue due date, in the warning colour", { due_at: "2026-10-01T12:00:00Z", due_state: "overdue" }, /Overdue, due/],
    ["a date-only due without a clock time", { due_at: "2026-11-03T23:59:00Z", time_zone: "UTC" }, /^[^:]*\b3\b[^:]*$/],
    ["a priority", { priority: "urgent" }, "Urgent"],
    ["subtask progress", { subtasks_total: 3, subtasks_done: 1 }, "1/3 subtasks"],
    ["tags", { tags: ["money"] }, "money"],
  ])("shows %s in the meta line", (_, overrides, text) => {
    const { row } = renderRow(overrides);
    const meta = row.querySelector(".task-meta") as HTMLElement;
    expect(meta).toHaveTextContent(text);
    if (overrides.due_state === "overdue") {
      expect(meta.querySelector(".task-due")).toHaveClass("is-overdue");
    }
    if (overrides.priority) {
      expect(meta.querySelector(".task-priority")).toHaveClass("priority-urgent");
    }
  });

  it("names the parent of a subtask and offers no project move (it shares the parent's)", () => {
    const { row } = renderRow({ parent_task_id: "parent" }, { parentTitle: "Launch" });
    expect(row.querySelector(".task-parent")).toHaveTextContent("Subtask of Launch");
    expect(screen.queryByRole("button", { name: /to a project/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Pay rent" }));
    expect(() => menuItem("Move to project")).toThrow();
  });

  it.each([
    ["next", false, false],
    ["completed", true, false],
    ["archived", false, true],
  ])("a %s task's round checkbox: checked=%s disabled=%s, and it toggles", (status, checked, disabled) => {
    const { actions, task } = renderRow({ status });
    const box = screen.getByRole("checkbox", { name: "Complete Pay rent" });
    expect(box).toHaveProperty("checked", checked);
    expect(box).toHaveProperty("disabled", disabled);
    fireEvent.click(box);
    if (disabled) expect(actions.toggleComplete).not.toHaveBeenCalled();
    else expect(actions.toggleComplete).toHaveBeenCalledWith(task);
  });

  it("has two persistent controls besides the title; the quick actions are a separate hover group", () => {
    const { row } = renderRow({ status: "inbox" });
    const actionsGroup = row.querySelector(".task-row-actions") as HTMLElement;
    const persistent = [...row.querySelectorAll("button, input")].filter(
      (control) => !actionsGroup.contains(control) && !control.classList.contains("task-open"),
    );
    expect(persistent.map((c) => c.getAttribute("aria-label"))).toEqual([
      "Complete Pay rent",
      "Actions for Pay rent",
    ]);
    expect(within(actionsGroup).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Schedule Pay rent for today",
      "Pick a date for Pay rent",
      "Move Pay rent to a project",
    ]);
  });

  it.each<[string, (a: TaskActions, t: Task) => unknown[] | undefined, string | null]>([
    ["x", (a) => vi.mocked(a.toggleComplete).mock.calls[0], null],
    ["t", (a) => vi.mocked(a.schedule).mock.calls[0], null],
    ["m", () => undefined, "Move to project"],
    ["p", () => undefined, "Priority"],
  ])("key %s on the focused row acts (or opens the %s menu)", (key, call, menu) => {
    const { actions, task } = renderRow();
    const title = screen.getByRole("button", { name: "Open Pay rent" });
    title.focus();
    fireEvent.keyDown(title, { key });
    if (menu) {
      expect(screen.getByRole("menu", { name: menu })).toBeInTheDocument();
    } else {
      expect(call(actions, task)?.[0]).toBe(task);
      if (key === "t") expect(vi.mocked(actions.schedule)).toHaveBeenCalledWith(task, "today");
    }
  });

  it("ignores list keys while typing and with modifiers", () => {
    const { actions } = renderRow();
    const title = screen.getByRole("button", { name: "Open Pay rent" });
    fireEvent.keyDown(title, { key: "x", ctrlKey: true });
    expect(actions.toggleComplete).not.toHaveBeenCalled();
  });

  it("x selects instead of completing when the row is selectable (Tasks page); Enter on a checkbox opens", () => {
    const onToggle = vi.fn();
    const { actions, onOpen } = renderRow({}, { selection: { selected: false, onToggle } });
    const select = screen.getByRole("checkbox", { name: "Select Pay rent" });
    fireEvent.keyDown(select, { key: "x" });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(actions.toggleComplete).not.toHaveBeenCalled();
    fireEvent.keyDown(select, { key: "Enter" });
    expect(onOpen).toHaveBeenCalled();
  });

  it.each<[string[], keyof TaskActions, unknown[]]>([
    [["Tomorrow"], "schedule", ["tomorrow"]],
    [["Next week"], "schedule", ["next-week"]],
    [["Priority", "High"], "setPriority", ["high"]],
    [["Move to project", "Home"], "moveToProject", ["p1"]],
    [["Status", "In progress"], "setStatus", ["in_progress"]],
    [["Delete"], "remove", []],
  ])("menu %j calls %s", (path, action, args) => {
    const { actions, task } = renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Pay rent" }));
    for (const name of path) fireEvent.click(menuItem(name));
    expect(actions[action]).toHaveBeenCalledWith(task, ...args);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("the status menu offers only the current status and the allowed moves", () => {
    renderRow({ status: "completed" });
    fireEvent.click(screen.getByRole("button", { name: "Actions for Pay rent" }));
    fireEvent.click(menuItem("Status"));
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual([
      "Completed",
      "In progress",
      "Archived",
    ]);
  });

  it("j and k move focus between rows", () => {
    const tasks = ["One", "Two", "Three"].map((title, i) => makeTask({ id: String(i), title }));
    render(
      <main>
        <ul>
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} actions={makeActions()} onOpen={vi.fn()} />
          ))}
        </ul>
      </main>,
    );
    const open = (title: string) => screen.getByRole("button", { name: `Open ${title}` });
    open("One").focus();
    fireEvent.keyDown(open("One"), { key: "j" });
    expect(open("Two")).toHaveFocus();
    fireEvent.keyDown(open("Two"), { key: "j" });
    fireEvent.keyDown(open("Three"), { key: "j" }); // stays on the last row
    expect(open("Three")).toHaveFocus();
    fireEvent.keyDown(open("Three"), { key: "k" });
    expect(open("Two")).toHaveFocus();
  });
});
