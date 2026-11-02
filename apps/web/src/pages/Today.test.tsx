import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { MemoryRouter, Route, Routes } from "react-router-dom";

import { notesApi, notificationsApi, tasksApi, type Task } from "../api/client";
import { localDate } from "../lib/taskForm";
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
  notesApi: { list: vi.fn(), get: vi.fn(), openDaily: vi.fn() },
}));

const listMock = vi.mocked(tasksApi.list);
const createMock = vi.mocked(tasksApi.create);
const completeMock = vi.mocked(tasksApi.complete);
const updateMock = vi.mocked(tasksApi.update);

/** The Today view and the scheduled-work query both use `tasksApi.list`; answer each separately. */
function mockTasks(view: Task[] | Error, scheduled: Task[] = []) {
  listMock.mockImplementation(async (options) => {
    if (options?.view) {
      if (view instanceof Error) throw view;
      return { tasks: view };
    }
    return { tasks: scheduled };
  });
}
const viewCalls = () =>
  listMock.mock.calls.filter(([options]) => options?.view).length;

function renderToday() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Today />} />
        <Route path="/notes" element={<p>Notes page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  // The task detail panel loads its subtasks and reminder when it opens.
  vi.mocked(tasksApi.subtasks).mockResolvedValue({ tasks: [] });
  vi.mocked(notesApi.list).mockResolvedValue({ notes: [], folders: [] });
  vi.mocked(notificationsApi.taskReminder).mockResolvedValue({
    override: null,
    effective: null,
    remind_at: null,
  });
});

describe("Today", () => {
  it("renders the overdue and due-today groups from the API", async () => {
    mockTasks([
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
    ]);

    renderToday();

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

  it("shows empty groups, the daily note slot and an empty events slot", async () => {
    mockTasks([]);

    renderToday();

    expect(await screen.findByText("Nothing overdue.")).toBeInTheDocument();
    expect(screen.getByText("Nothing else due today.")).toBeInTheDocument();
    expect(screen.getByText("No note for today yet.")).toBeInTheDocument();
    const events = screen.getByRole("region", { name: "Events" });
    expect(
      within(events).getByText(/once a calendar is connected/),
    ).toBeInTheDocument();
    expect(within(events).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("lists open work scheduled to start today, once, and ignores other days", async () => {
    const day = localDate();
    const next = localDate(1);
    mockTasks(
      [
        makeTask({
          id: "d",
          title: "Due and started",
          due_state: "today",
          start_at: `${day}T09:00:00`,
        }),
      ],
      [
        makeTask({
          id: "d",
          title: "Due and started",
          start_at: `${day}T09:00:00`,
        }),
        makeTask({ id: "s", title: "Start me", start_at: `${day}T10:00:00` }),
        makeTask({
          id: "n",
          title: "Starts tomorrow",
          start_at: `${next}T01:00:00`,
        }),
      ],
    );

    renderToday();

    const scheduled = await screen.findByRole("region", {
      name: "Scheduled work",
    });
    await within(scheduled).findByText("Start me");
    expect(
      within(scheduled).queryByText("Due and started"),
    ).not.toBeInTheDocument();
    expect(
      within(scheduled).queryByText("Starts tomorrow"),
    ).not.toBeInTheDocument();
    const query = listMock.mock.calls.find(([options]) => !options?.view)?.[0];
    expect(query?.status).toEqual(["inbox", "next", "in_progress"]);
    expect(
      query?.startFrom && query.startTo && query.startFrom < query.startTo,
    ).toBe(true);
  });

  describe("today's note", () => {
    const dailySummary = {
      id: "n1",
      path: `daily/${localDate()}.md`,
      title: "Day",
      revision: 1,
      content_hash: "h",
      size_bytes: 1,
    };

    it("previews an existing note as plain text and opens it", async () => {
      mockTasks([]);
      vi.mocked(notesApi.list).mockResolvedValue({
        notes: [dailySummary],
        folders: [],
      });
      vi.mocked(notesApi.get).mockResolvedValue({
        ...dailySummary,
        content: "# Day\n\n<b>wrote</b> something\n",
      } as never);
      vi.mocked(notesApi.openDaily).mockResolvedValue({ id: "n1" } as never);

      renderToday();

      const card = await screen.findByRole("region", { name: "Daily note" });
      expect(
        await within(card).findByText("<b>wrote</b> something"),
      ).toBeInTheDocument();
      fireEvent.click(
        within(card).getByRole("button", { name: "Open today's note" }),
      );
      expect(await screen.findByText("Notes page")).toBeInTheDocument();
      expect(notesApi.openDaily).toHaveBeenCalledWith(localDate());
    });

    it("creates the note on demand and shows a server error verbatim", async () => {
      mockTasks([]);
      vi.mocked(notesApi.openDaily).mockRejectedValueOnce(
        new Error("A note or folder already exists there"),
      );

      renderToday();

      const card = await screen.findByRole("region", { name: "Daily note" });
      fireEvent.click(
        await within(card).findByRole("button", {
          name: "Create today's note",
        }),
      );
      expect(await within(card).findByRole("alert")).toHaveTextContent(
        "A note or folder already exists there",
      );
      expect(screen.queryByText("Notes page")).not.toBeInTheDocument();
    });
  });

  it("shows a clear error and can retry", async () => {
    mockTasks(new Error("Server unreachable"));

    renderToday();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Server unreachable",
    );

    mockTasks([makeTask({ id: "t1", title: "Recovered", due_state: "today" })]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Recovered")).toBeInTheDocument();
  });

  it("quick-captures a task due today in the viewer's zone, then refreshes", async () => {
    mockTasks([]);
    createMock.mockResolvedValue(makeTask({ id: "new", title: "Buy milk" }));

    renderToday();
    await screen.findByText("Nothing overdue.");

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
    expect(viewCalls()).toBe(2);
  });

  it("opens the task detail from a row, saves an edit and refreshes the list", async () => {
    const task = makeTask({
      id: "t1",
      title: "Write report",
      due_state: "today",
    });
    mockTasks([task]);
    updateMock.mockResolvedValue(
      makeTask({ ...task, priority: "high", revision: 2 }),
    );

    renderToday();
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
    await waitFor(() => expect(viewCalls()).toBe(2));
  });

  it("closes the detail with Escape", async () => {
    mockTasks([
      makeTask({ id: "t1", title: "Write report", due_state: "today" }),
    ]);

    renderToday();
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
    mockTasks([task]);
    completeMock.mockResolvedValue(makeTask({ ...task, status: "completed" }));

    renderToday();
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Complete Write report" }),
    );

    await waitFor(() => expect(completeMock).toHaveBeenCalledWith(task));
    expect(viewCalls()).toBe(2);
  });

  it("surfaces a completion failure without losing the view", async () => {
    mockTasks([
      makeTask({ id: "t1", title: "Write report", due_state: "today" }),
    ]);
    completeMock.mockRejectedValue(new Error("Revision conflict"));

    renderToday();
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Complete Write report" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Revision conflict",
    );
    expect(screen.getByText("Write report")).toBeInTheDocument();
  });
});
