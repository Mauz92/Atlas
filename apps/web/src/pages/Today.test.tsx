import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { tasksApi } from "../api/client";
import { makeTask } from "../test/tasks";
import { Today } from "./Today";

vi.mock("../api/client", () => ({
  tasksApi: { list: vi.fn(), create: vi.fn(), complete: vi.fn() },
}));

const listMock = vi.mocked(tasksApi.list);
const createMock = vi.mocked(tasksApi.create);
const completeMock = vi.mocked(tasksApi.complete);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Today", () => {
  it("renders the overdue and due-today groups from the API", async () => {
    listMock.mockResolvedValue({
      tasks: [
        makeTask({
          id: "o1",
          title: "Pay rent",
          due_state: "overdue",
          due_at: "2026-10-20T09:00:00+00:00",
        }),
        makeTask({
          id: "t1",
          title: "Write report",
          due_state: "today",
          due_at: "2026-10-26T15:00:00+00:00",
        }),
      ],
    });

    render(<Today />);

    expect(await screen.findByText("Pay rent")).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ view: "today" }));

    const overdue = screen.getByRole("heading", { name: "Overdue" }).closest("section");
    const dueToday = screen.getByRole("heading", { name: "Due today" }).closest("section");
    expect(overdue).not.toBeNull();
    expect(dueToday).not.toBeNull();
    expect(within(overdue as HTMLElement).getByText("Pay rent")).toBeInTheDocument();
    expect(within(dueToday as HTMLElement).getByText("Write report")).toBeInTheDocument();
  });

  it("shows a useful empty state when nothing is due today", async () => {
    listMock.mockResolvedValue({ tasks: [] });

    render(<Today />);

    expect(await screen.findByText(/Nothing is due today/i)).toBeInTheDocument();
  });

  it("shows a clear error and can retry", async () => {
    listMock.mockRejectedValueOnce(new Error("Server unreachable"));

    render(<Today />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Server unreachable");

    listMock.mockResolvedValueOnce({
      tasks: [makeTask({ id: "t1", title: "Recovered", due_state: "today" })],
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Recovered")).toBeInTheDocument();
  });

  it("quick-captures a task with a title only, then refreshes", async () => {
    listMock.mockResolvedValue({ tasks: [] });
    createMock.mockResolvedValue(makeTask({ id: "new", title: "Buy milk" }));

    render(<Today />);
    await screen.findByText(/Nothing is due today/i);

    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Buy milk" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(createMock).toHaveBeenCalledWith("Buy milk"));
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("completes a task from the view and refreshes", async () => {
    const task = makeTask({ id: "t1", title: "Write report", due_state: "today" });
    listMock.mockResolvedValue({ tasks: [task] });
    completeMock.mockResolvedValue(makeTask({ ...task, status: "completed" }));

    render(<Today />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete Write report" }));

    await waitFor(() => expect(completeMock).toHaveBeenCalledWith(task));
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a completion failure without losing the view", async () => {
    listMock.mockResolvedValue({
      tasks: [makeTask({ id: "t1", title: "Write report", due_state: "today" })],
    });
    completeMock.mockRejectedValue(new Error("Revision conflict"));

    render(<Today />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete Write report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Revision conflict");
    expect(screen.getByText("Write report")).toBeInTheDocument();
  });
});
