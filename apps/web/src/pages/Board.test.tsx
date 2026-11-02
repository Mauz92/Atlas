import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ApiError, tasksApi } from "../api/client";
import { choose } from "../test/menu";
import { makeTask } from "../test/tasks";
import { BoardPage } from "./Board";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    tasksApi: { list: vi.fn(), create: vi.fn(), complete: vi.fn(), setStatus: vi.fn() },
  };
});

const listMock = vi.mocked(tasksApi.list);
const setStatusMock = vi.mocked(tasksApi.setStatus);

beforeEach(() => {
  vi.resetAllMocks();
});

function column(name: string): HTMLElement {
  return screen.getByRole("heading", { name }).closest("section") as HTMLElement;
}

describe("BoardPage", () => {
  it("renders one column per status with the tasks returned by the API", async () => {
    listMock.mockResolvedValue({
      tasks: [
        makeTask({ id: "a", title: "Alpha", status: "inbox" }),
        makeTask({ id: "b", title: "Beta", status: "in_progress" }),
      ],
    });

    render(<BoardPage />);

    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(within(column("Inbox")).getByText("Alpha")).toBeInTheDocument();
    expect(within(column("In progress")).getByText("Beta")).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("persists a valid move and re-renders the card in its new column", async () => {
    const task = makeTask({ id: "a", title: "Alpha", status: "inbox", revision: 3 });
    listMock.mockResolvedValue({ tasks: [task] });
    setStatusMock.mockResolvedValue(
      makeTask({ ...task, status: "in_progress", revision: 4 }),
    );

    render(<BoardPage />);

    await choose("Actions for Alpha", "Move to…", "In progress");

    await waitFor(() => expect(setStatusMock).toHaveBeenCalledWith(task, "in_progress"));
    expect(await within(column("In progress")).findByText("Alpha")).toBeInTheDocument();
    expect(within(column("Inbox")).queryByText("Alpha")).not.toBeInTheDocument();
  });

  it("surfaces a stale (409) rejection and leaves the card where it was", async () => {
    const task = makeTask({ id: "a", title: "Alpha", status: "inbox", revision: 3 });
    listMock.mockResolvedValue({ tasks: [task] });
    setStatusMock.mockRejectedValue(
      new ApiError(409, "task changed since it was read", {
        detail: { message: "task changed since it was read", current_revision: 5 },
      }),
    );

    render(<BoardPage />);

    await choose("Actions for Alpha", "Move to…", "In progress");

    expect(await screen.findByRole("alert")).toHaveTextContent(/changed elsewhere/i);
    expect(within(column("Inbox")).getByText("Alpha")).toBeInTheDocument();
    expect(within(column("In progress")).queryByText("Alpha")).not.toBeInTheDocument();
  });

  it("reports an invalid transition the server rejects", async () => {
    const task = makeTask({ id: "c", title: "Gamma", status: "completed", revision: 2 });
    listMock.mockResolvedValue({ tasks: [task] });
    setStatusMock.mockRejectedValue(
      new ApiError(409, "invalid status transition", {
        detail: {
          message: "invalid status transition",
          current: "completed",
          requested: "next",
          allowed: ["in_progress", "archived"],
        },
      }),
    );

    render(<BoardPage />);

    await choose("Actions for Gamma", "Move to…", "In progress");

    expect(await screen.findByRole("alert")).toHaveTextContent("invalid status transition");
    expect(setStatusMock).toHaveBeenCalledTimes(1);
  });

  it("shows a useful empty state with every column present", async () => {
    listMock.mockResolvedValue({ tasks: [] });

    render(<BoardPage />);

    expect(await screen.findByText(/Nothing on the board yet/i)).toBeInTheDocument();
    expect(screen.getAllByText("No tasks")).toHaveLength(5);
    expect(screen.getByRole("heading", { name: "Archived" })).toBeInTheDocument();
  });

  it("shows a clear error when the board fails to load and can retry", async () => {
    listMock.mockRejectedValueOnce(new Error("Board unavailable"));

    render(<BoardPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Board unavailable");

    listMock.mockResolvedValueOnce({ tasks: [makeTask({ id: "a", title: "Alpha" })] });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Alpha")).toBeInTheDocument();
  });
});
