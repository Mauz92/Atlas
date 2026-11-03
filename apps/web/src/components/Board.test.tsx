import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";

import type { Task } from "../api/client";
import { boardColumns, groupByStatus } from "../lib/taskStatus";
import { menuItem } from "../test/menu";
import { makeTask } from "../test/tasks";
import { Board } from "./Board";

/** A minimal stand-in for the browser's `DataTransfer` (jsdom does not implement drag events). */
function makeDataTransfer() {
  const store: Record<string, string> = {};
  return {
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? "",
    effectAllowed: "",
    dropEffect: "",
  };
}

function column(name: string): HTMLElement {
  return screen
    .getByRole("heading", { name })
    .closest("section") as HTMLElement;
}

function renderBoard(tasks: Task[], onMove = vi.fn(), empty = false) {
  render(
    <Board
      columns={boardColumns()}
      tasksByStatus={groupByStatus(tasks)}
      onMove={onMove}
      onOpen={() => {}}
      empty={empty}
    />,
  );
  return { onMove };
}

describe("Board", () => {
  it("renders one column per status with the tasks that belong to it", () => {
    renderBoard([
      makeTask({ id: "a", title: "Alpha", status: "inbox" }),
      makeTask({ id: "b", title: "Beta", status: "in_progress" }),
      makeTask({ id: "c", title: "Gamma", status: "inbox" }),
    ]);

    for (const label of [
      "Inbox",
      "Next",
      "In progress",
      "Completed",
      "Archived",
    ]) {
      expect(screen.getByRole("heading", { name: label })).toBeInTheDocument();
    }
    expect(within(column("Inbox")).getByText("Alpha")).toBeInTheDocument();
    expect(within(column("Inbox")).getByText("Gamma")).toBeInTheDocument();
    expect(within(column("In progress")).getByText("Beta")).toBeInTheDocument();
    expect(within(column("Inbox")).getByText("2")).toBeInTheDocument();
  });

  it("renders every column with an empty placeholder when there is nothing to show", () => {
    renderBoard([], vi.fn(), true);

    expect(screen.getAllByRole("heading")).toHaveLength(5);
    expect(screen.getAllByText("No tasks")).toHaveLength(5);
    expect(screen.getByText(/Nothing on the board yet/i)).toBeInTheDocument();
  });

  it("moves a card to another column by drag and drop", () => {
    const { onMove } = renderBoard([
      makeTask({ id: "a", title: "Alpha", status: "inbox", revision: 2 }),
    ]);

    const card = screen.getByText("Alpha").closest("li") as HTMLElement;
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(column("In progress"), { dataTransfer });
    fireEvent.drop(column("In progress"), { dataTransfer });

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", revision: 2 }),
      "in_progress",
    );
  });

  it("refuses a drop into a column the state machine forbids", () => {
    const { onMove } = renderBoard([
      makeTask({ id: "c", title: "Gamma", status: "completed" }),
    ]);

    const card = screen.getByText("Gamma").closest("li") as HTMLElement;
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(column("Next"), { dataTransfer });
    fireEvent.drop(column("Next"), { dataTransfer });

    expect(onMove).not.toHaveBeenCalled();
  });

  it("offers a keyboard alternative: the card menu's Move to… lists only allowed targets", () => {
    const { onMove } = renderBoard([
      makeTask({ id: "c", title: "Gamma", status: "completed" }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Actions for Gamma" }));
    fireEvent.click(menuItem("Move to…"));
    // Completed tasks may only be reopened or archived; the current status is marked.
    const choices = screen.getAllByRole("menuitemradio").map((item) => item.textContent);
    expect(choices).toEqual(["Completed", "In progress", "Archived"]);
    expect(menuItem("Completed")).toHaveAttribute("aria-checked", "true");

    fireEvent.click(menuItem("In progress"));

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c" }),
      "in_progress",
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens a card in the task detail from its title", () => {
    const onOpen = vi.fn();
    const task = makeTask({ id: "a", title: "Alpha", status: "inbox" });
    render(
      <Board
        columns={boardColumns()}
        tasksByStatus={groupByStatus([task])}
        onMove={vi.fn()}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Alpha" }));
    expect(onOpen).toHaveBeenCalledWith(task);
  });

  describe("keyboard moves with [ and ]", () => {
    it("moves the focused card to the next allowed column and back", () => {
      const { onMove } = renderBoard([makeTask({ id: "a", title: "Alpha", status: "next" })]);
      const title = screen.getByRole("button", { name: "Open Alpha" });
      title.focus();
      fireEvent.keyDown(title, { key: "]" });
      expect(onMove).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), "in_progress");
      fireEvent.keyDown(title, { key: "[" });
      expect(onMove).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), "inbox");
    });

    it("skips forbidden columns and says so at an edge", () => {
      const { onMove } = renderBoard([
        makeTask({ id: "c", title: "Gamma", status: "completed" }),
        makeTask({ id: "i", title: "Iota", status: "inbox" }),
      ]);
      const gamma = screen.getByRole("button", { name: "Open Gamma" });
      fireEvent.keyDown(gamma, { key: "[" });
      expect(onMove).toHaveBeenLastCalledWith(expect.objectContaining({ id: "c" }), "in_progress");
      const iota = screen.getByRole("button", { name: "Open Iota" });
      onMove.mockClear();
      fireEvent.keyDown(iota, { key: "[" });
      expect(onMove).not.toHaveBeenCalled();
      expect(screen.getByText("Iota cannot move left from Inbox")).toBeInTheDocument();
    });

    it("keeps focus on the card after it lands in another column, and announces it", () => {
      function Host() {
        const [tasks, setTasks] = useState([makeTask({ id: "a", title: "Alpha", status: "inbox" })]);
        return (
          <Board
            columns={boardColumns()}
            tasksByStatus={groupByStatus(tasks)}
            onOpen={() => {}}
            onMove={(task, status) =>
              setTasks((current) =>
                current.map((t) => (t.id === task.id ? { ...t, status: status as Task["status"] } : t)),
              )
            }
          />
        );
      }
      render(<Host />);
      const title = screen.getByRole("button", { name: "Open Alpha" });
      title.focus();
      fireEvent.keyDown(title, { key: "]" });
      expect(within(column("Next")).getByRole("button", { name: "Open Alpha" })).toHaveFocus();
      expect(screen.getByText("Moved Alpha to Next")).toBeInTheDocument();
    });

    it("ignores the keys while typing and with modifiers", () => {
      const { onMove } = renderBoard([makeTask({ id: "a", title: "Alpha", status: "next" })]);
      const title = screen.getByRole("button", { name: "Open Alpha" });
      fireEvent.keyDown(title, { key: "]", ctrlKey: true });
      expect(onMove).not.toHaveBeenCalled();
    });
  });

  it("keeps Archived behind a toggle when asked, and counts what is hidden", () => {
    render(
      <Board
        columns={boardColumns()}
        tasksByStatus={groupByStatus([
          makeTask({ id: "z", title: "Zed", status: "archived" }),
          makeTask({ id: "a", title: "Alpha", status: "inbox" }),
        ])}
        onMove={vi.fn()}
        archivedToggle
      />,
    );
    expect(screen.getAllByRole("heading")).toHaveLength(4);
    expect(screen.queryByText("Zed")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show archived (1)" }));
    expect(screen.getAllByRole("heading")).toHaveLength(5);
    expect(screen.getByText("Zed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide archived" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows compact cards: the priority is an icon with a screen-reader name, tags are left out", () => {
    renderBoard([
      makeTask({ id: "a", title: "Alpha", status: "next", priority: "high", tags: ["home"] }),
    ]);
    const card = screen.getByText("Alpha").closest("li") as HTMLElement;
    expect(within(card).getByText("High priority")).toHaveClass("sr-only");
    expect(within(card).queryByText("home")).not.toBeInTheDocument();
  });
});
