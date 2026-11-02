import { fireEvent, render, screen, within } from "@testing-library/react";

import type { Task } from "../api/client";
import { boardColumns, groupByStatus } from "../lib/taskStatus";
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

  it("offers a keyboard alternative that only enables allowed targets", () => {
    const { onMove } = renderBoard([
      makeTask({ id: "c", title: "Gamma", status: "completed" }),
    ]);

    const select = screen.getByLabelText("Move Gamma");
    // Completed tasks may only be reopened or archived.
    expect(within(select).getByRole("option", { name: "Next" })).toBeDisabled();
    expect(
      within(select).getByRole("option", { name: "Inbox" }),
    ).toBeDisabled();
    expect(
      within(select).getByRole("option", { name: "In progress" }),
    ).toBeEnabled();
    expect(
      within(select).getByRole("option", { name: "Archived" }),
    ).toBeEnabled();

    fireEvent.change(select, { target: { value: "in_progress" } });

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c" }),
      "in_progress",
    );
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
});
