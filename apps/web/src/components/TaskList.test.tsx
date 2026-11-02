import { fireEvent, render, screen } from "@testing-library/react";

import { makeTask } from "../test/tasks";
import { TaskList } from "./TaskList";

describe("TaskList", () => {
  it("opens a task from its title button and shows tags and a date-only due without a clock time", () => {
    const onOpen = vi.fn();
    const task = makeTask({
      id: "a",
      title: "Pay rent",
      tags: ["money"],
      due_at: "2026-11-03T22:59:00Z",
      time_zone: "Europe/Stockholm",
    });
    render(<TaskList tasks={[task]} timeZone="UTC" onOpen={onOpen} />);

    fireEvent.click(screen.getByRole("button", { name: "Open Pay rent" }));
    expect(onOpen).toHaveBeenCalledWith(task);
    expect(screen.getByText("money")).toBeInTheDocument();
    expect(screen.getByText(/\b3\b/)).not.toHaveTextContent(/\d:\d\d/);
  });

  it("renders a plain title when the list cannot open tasks", () => {
    render(<TaskList tasks={[makeTask({ title: "Read only" })]} />);
    expect(
      screen.queryByRole("button", { name: /Open/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Read only")).toBeInTheDocument();
  });

  it("renders per-row actions", () => {
    render(
      <TaskList
        tasks={[makeTask({ title: "A" })]}
        renderActions={(task) => (
          <button type="button">Act on {task.title}</button>
        )}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Act on A" }),
    ).toBeInTheDocument();
  });
});
