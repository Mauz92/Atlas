import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { notificationsApi, tasksApi } from "../api/client";
import { makeTask } from "../test/tasks";
import { Today } from "./Today";

vi.mock("../api/client", () => ({
  tasksApi: {
    list: vi.fn(),
    create: vi.fn(),
    complete: vi.fn(),
    update: vi.fn(),
    get: vi.fn(),
    remove: vi.fn(),
    restore: vi.fn(),
    subtasks: vi.fn(),
  },
  notificationsApi: { taskReminder: vi.fn() },
}));

const listMock = vi.mocked(tasksApi.list);
const createMock = vi.mocked(tasksApi.create);
const completeMock = vi.mocked(tasksApi.complete);
const updateMock = vi.mocked(tasksApi.update);

beforeEach(() => {
  vi.resetAllMocks();
  // The task detail panel loads its subtasks and reminder when it opens.
  vi.mocked(tasksApi.subtasks).mockResolvedValue({ tasks: [] });
  vi.mocked(notificationsApi.taskReminder).mockResolvedValue({
    override: null,
    effective: null,
    remind_at: null,
  });
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
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ view: "today" }),
    );

    const overdue = screen
      .getByRole("heading", { name: "Overdue" })
      .closest("section");
    const dueToday = screen
      .getByRole("heading", { name: "Due today" })
      .closest("section");
    expect(overdue).not.toBeNull();
    expect(dueToday).not.toBeNull();
    expect(
      within(overdue as HTMLElement).getByText("Pay rent"),
    ).toBeInTheDocument();
    expect(
      within(dueToday as HTMLElement).getByText("Write report"),
    ).toBeInTheDocument();
  });

  it("shows a useful empty state when nothing is due today", async () => {
    listMock.mockResolvedValue({ tasks: [] });

    render(<Today />);

    expect(
      await screen.findByText(/Nothing is due today/i),
    ).toBeInTheDocument();
  });

  it("shows a clear error and can retry", async () => {
    listMock.mockRejectedValueOnce(new Error("Server unreachable"));

    render(<Today />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Server unreachable",
    );

    listMock.mockResolvedValueOnce({
      tasks: [makeTask({ id: "t1", title: "Recovered", due_state: "today" })],
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Recovered")).toBeInTheDocument();
  });

  it("quick-captures a task due today in the viewer's zone, then refreshes", async () => {
    listMock.mockResolvedValue({ tasks: [] });
    createMock.mockResolvedValue(makeTask({ id: "new", title: "Buy milk" }));

    render(<Today />);
    await screen.findByText(/Nothing is due today/i);

    fireEvent.change(screen.getByLabelText("Task title"), {
      target: { value: "Buy milk" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    const today = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(
        "Buy milk",
        expect.objectContaining({ due_at: `${today}T23:59:00` }),
      ),
    );
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("opens the task detail from a row, saves an edit and refreshes the list", async () => {
    const task = makeTask({
      id: "t1",
      title: "Write report",
      due_state: "today",
    });
    listMock.mockResolvedValue({ tasks: [task] });
    updateMock.mockResolvedValue(
      makeTask({ ...task, priority: "high", revision: 2 }),
    );

    render(<Today />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Write report" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "Task details" });
    fireEvent.change(within(dialog).getByLabelText("Priority"), {
      target: { value: "high" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(task, { priority: "high" }),
    );
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it("closes the detail with Escape", async () => {
    listMock.mockResolvedValue({
      tasks: [
        makeTask({ id: "t1", title: "Write report", due_state: "today" }),
      ],
    });

    render(<Today />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Write report" }),
    );
    await screen.findByRole("dialog", { name: "Task details" });

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("completes a task from the view and refreshes", async () => {
    const task = makeTask({
      id: "t1",
      title: "Write report",
      due_state: "today",
    });
    listMock.mockResolvedValue({ tasks: [task] });
    completeMock.mockResolvedValue(makeTask({ ...task, status: "completed" }));

    render(<Today />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Complete Write report" }),
    );

    await waitFor(() => expect(completeMock).toHaveBeenCalledWith(task));
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a completion failure without losing the view", async () => {
    listMock.mockResolvedValue({
      tasks: [
        makeTask({ id: "t1", title: "Write report", due_state: "today" }),
      ],
    });
    completeMock.mockRejectedValue(new Error("Revision conflict"));

    render(<Today />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Complete Write report" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Revision conflict",
    );
    expect(screen.getByText("Write report")).toBeInTheDocument();
  });
});
