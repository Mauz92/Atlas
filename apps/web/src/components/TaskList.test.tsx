import { render, screen, waitFor } from "@testing-library/react";

import { tasksApi } from "../api/client";
import type { TaskActions } from "../hooks/useTaskActions";
import { resetParentTitles } from "../hooks/useParentTitles";
import { makeTask } from "../test/tasks";
import { TaskList } from "./TaskList";

vi.mock("../api/client", () => ({ tasksApi: { get: vi.fn() } }));

const actions: TaskActions = {
  toggleComplete: vi.fn(),
  schedule: vi.fn(),
  setPriority: vi.fn(),
  moveToProject: vi.fn(),
  setStatus: vi.fn(),
  remove: vi.fn(),
  busy: new Set(),
  error: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  resetParentTitles();
});

describe("TaskList", () => {
  it("renders read-only rows (no checkbox, no menu) without actions", () => {
    render(<TaskList tasks={[makeTask({ title: "Read only" })]} />);
    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  // UX-03 regression: subtasks were listed as top-level rows with no parent shown.
  it.each([
    ["listed next to it", true],
    ["only read from the API", false],
  ])("names a subtask's parent when the parent is %s", async (_, listed) => {
    const parent = makeTask({ id: "p", title: "Launch" });
    const child = makeTask({ id: "c", title: "Demo script", parent_task_id: "p" });
    vi.mocked(tasksApi.get).mockResolvedValue(parent);
    render(<TaskList tasks={listed ? [parent, child] : [child]} onOpen={vi.fn()} />);
    await waitFor(() =>
      expect(document.querySelector(".task-parent")).toHaveTextContent("Subtask of Launch"),
    );
    expect(tasksApi.get).toHaveBeenCalledTimes(listed ? 0 : 1);
  });

  it("moves focus to the row that takes the place of a focused row that left", async () => {
    const tasks = ["One", "Two", "Three"].map((title, i) => makeTask({ id: String(i), title }));
    const { rerender } = render(<TaskList tasks={tasks} actions={actions} onOpen={vi.fn()} />);
    screen.getByRole("button", { name: "Open Two" }).focus();
    rerender(<TaskList tasks={[tasks[0], tasks[2]]} actions={actions} onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Open Three" })).toHaveFocus());
  });
});
