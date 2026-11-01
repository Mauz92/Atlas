import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { projectsApi, tasksApi } from "../api/client";
import { addDays, dayLabelOf, dayWindow, startOfDay } from "../lib/planning";
import { makeProject, makeTask } from "../test/tasks";
import { Day } from "./Day";

vi.mock("../api/client", () => ({
  tasksApi: { list: vi.fn(), create: vi.fn(), complete: vi.fn() },
  projectsApi: { list: vi.fn() },
}));

const listMock = vi.mocked(tasksApi.list);
const projectsMock = vi.mocked(projectsApi.list);
const completeMock = vi.mocked(tasksApi.complete);

const today = startOfDay(new Date());
const tomorrow = addDays(today, 1);
const tomorrowWindow = dayWindow(tomorrow);

beforeEach(() => {
  vi.resetAllMocks();
  projectsMock.mockResolvedValue({ projects: [] });
});

describe("Day", () => {
  it("opens on today using the server's today view, with overdue and due-today groups", async () => {
    listMock.mockResolvedValue({
      tasks: [
        makeTask({
          id: "o1",
          title: "Pay rent",
          due_state: "overdue",
          due_at: "2026-10-20T09:00:00+00:00",
        }),
        makeTask({ id: "t1", title: "Write report", due_state: "today" }),
      ],
    });

    render(<Day />);

    expect(await screen.findByText("Pay rent")).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ view: "today" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Today · /);

    const overdue = screen.getByRole("heading", { name: "Overdue" }).closest("section");
    const dueToday = screen.getByRole("heading", { name: "Due today" }).closest("section");
    expect(within(overdue as HTMLElement).getByText("Pay rent")).toBeInTheDocument();
    expect(within(dueToday as HTMLElement).getByText("Write report")).toBeInTheDocument();
  });

  it("loads another local day from the due window and can return to today", async () => {
    listMock.mockResolvedValue({ tasks: [] });

    render(<Day />);
    await screen.findByText(/Nothing planned for this day/i);

    fireEvent.click(screen.getByRole("button", { name: "Next day" }));

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          dueFrom: tomorrowWindow.dueFrom,
          dueTo: tomorrowWindow.dueTo,
          status: ["inbox", "next", "in_progress"],
        }),
      ),
    );
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(dayLabelOf(tomorrow));
    expect(heading).not.toHaveTextContent(/Today · /);

    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ view: "today" })),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Today · /);
  });

  it("shows only the tasks that fall on the selected local day", async () => {
    listMock.mockResolvedValue({
      tasks: [
        makeTask({ id: "in", title: "Dentist", due_state: "upcoming", due_at: tomorrowWindow.dueFrom }),
        makeTask({ id: "out", title: "Later still", due_state: "upcoming", due_at: tomorrowWindow.dueTo }),
      ],
    });

    render(<Day />);
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));

    expect(await screen.findByText("Dentist")).toBeInTheDocument();
    // The task due at the closing midnight belongs to the day after, not this one.
    expect(screen.queryByText("Later still")).toBeNull();
  });

  it("shows the project context (name and derived progress) of the planned tasks", async () => {
    listMock.mockResolvedValue({
      tasks: [makeTask({ id: "t1", title: "Write report", due_state: "today", project_id: "p1" })],
    });
    projectsMock.mockResolvedValue({
      projects: [
        makeProject({ id: "p1", name: "Atlas launch", progress: { total: 5, completed: 3, percent: 60 } }),
      ],
    });

    render(<Day />);

    expect(await screen.findByText("Write report")).toBeInTheDocument();
    // Once as the task's project tag, once in the plan's project summary.
    expect(screen.getAllByText("Atlas launch")).toHaveLength(2);
    expect(screen.getByText("3/5 · 60%")).toBeInTheDocument();
  });

  it("keeps the plan visible when project context fails to load", async () => {
    listMock.mockResolvedValue({
      tasks: [makeTask({ id: "t1", title: "Write report", due_state: "today" })],
    });
    projectsMock.mockRejectedValue(new Error("projects unavailable"));

    render(<Day />);

    expect(await screen.findByText("Write report")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Project names are unavailable/i);
  });

  it("shows a useful empty state for a day with nothing planned", async () => {
    listMock.mockResolvedValue({ tasks: [] });

    render(<Day />);

    expect(await screen.findByText(/Nothing planned for this day/i)).toBeInTheDocument();
  });

  it("shows a clear error and can retry", async () => {
    listMock.mockRejectedValueOnce(new Error("Server unreachable"));

    render(<Day />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Server unreachable");

    listMock.mockResolvedValueOnce({
      tasks: [makeTask({ id: "t1", title: "Recovered", due_state: "today" })],
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Recovered")).toBeInTheDocument();
  });

  it("completes a task from the day and refreshes", async () => {
    const task = makeTask({ id: "t1", title: "Write report", due_state: "today" });
    listMock.mockResolvedValue({ tasks: [task] });
    completeMock.mockResolvedValue(makeTask({ ...task, status: "completed" }));

    render(<Day />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete Write report" }));

    await waitFor(() => expect(completeMock).toHaveBeenCalledWith(task));
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a completion failure without losing the plan", async () => {
    listMock.mockResolvedValue({
      tasks: [makeTask({ id: "t1", title: "Write report", due_state: "today" })],
    });
    completeMock.mockRejectedValue(new Error("Revision conflict"));

    render(<Day />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete Write report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Revision conflict");
    expect(screen.getByText("Write report")).toBeInTheDocument();
  });
});
