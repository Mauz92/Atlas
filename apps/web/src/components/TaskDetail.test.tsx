import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ApiError, notificationsApi, tasksApi } from "../api/client";
import { makeProject, makeTask } from "../test/tasks";
import { TaskDetail } from "./TaskDetail";

vi.mock("../api/client", async () => {
  const actual =
    await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ApiError: actual.ApiError,
    tasksApi: {
      update: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(),
      list: vi.fn(),
      subtasks: vi.fn(),
      addSubtask: vi.fn(),
      complete: vi.fn(),
      previewRecurrence: vi.fn(),
    },
    notificationsApi: { taskReminder: vi.fn(), setTaskReminder: vi.fn() },
  };
});

const updateMock = vi.mocked(tasksApi.update);
const getMock = vi.mocked(tasksApi.get);
const removeMock = vi.mocked(tasksApi.remove);

const task = makeTask({
  id: "t1",
  title: "Buy milk",
  description: "Semi-skimmed",
  priority: "low",
  tags: ["home"],
  due_at: "2026-11-03T09:30:00Z",
  time_zone: "UTC",
});

function setup(
  overrides: Partial<React.ComponentProps<typeof TaskDetail>> = {},
) {
  const props = {
    task,
    timeZone: "UTC",
    onClose: vi.fn(),
    onSaved: vi.fn(),
    onDeleted: vi.fn(),
    ...overrides,
  };
  render(<TaskDetail {...props} />);
  return props;
}

beforeEach(() => {
  vi.resetAllMocks();
  getMock.mockResolvedValue(task);
  vi.mocked(tasksApi.subtasks).mockResolvedValue({ tasks: [] });
  vi.mocked(notificationsApi.taskReminder).mockResolvedValue({
    override: null,
    effective: null,
    remind_at: null,
  });
});

describe("TaskDetail", () => {
  it("shows every editable field of the task and focuses the title", () => {
    setup();
    expect(
      screen.getByRole("dialog", { name: "Task details" }),
    ).toBeInTheDocument();
    const title = screen.getByLabelText("Title");
    expect(title).toHaveValue("Buy milk");
    expect(title).toHaveFocus();
    expect(screen.getByLabelText("Description")).toHaveValue("Semi-skimmed");
    expect(screen.getByLabelText("Status")).toHaveValue("inbox");
    expect(screen.getByLabelText("Priority")).toHaveValue("low");
    expect(screen.getByLabelText("Due date")).toHaveValue("2026-11-03");
    expect(screen.getByLabelText("Due time")).toHaveValue("09:30");
    expect(screen.getByLabelText("Time zone")).toHaveValue("UTC");
    expect(screen.getByLabelText("Tags")).toHaveValue("home");
  });

  it("only offers the status moves the state machine allows", () => {
    setup({ task: makeTask({ status: "completed" }) });
    const options = Array.from(
      (screen.getByLabelText("Status") as HTMLSelectElement).options,
    ).filter((option) => option.disabled);
    expect(options.map((option) => option.value).sort()).toEqual([
      "inbox",
      "next",
    ]);
  });

  it("keeps Save disabled until something changes, then sends only the change", async () => {
    updateMock.mockResolvedValue({
      ...task,
      title: "Buy oat milk",
      revision: 2,
    });
    const props = setup();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Buy oat milk" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(task, { title: "Buy oat milk" }),
    );
    await waitFor(() =>
      expect(props.onSaved).toHaveBeenCalledWith(
        expect.objectContaining({ revision: 2 }),
      ),
    );
  });

  it("moves the task between projects (archived ones are not offered) and detaches it", async () => {
    updateMock.mockResolvedValue({ ...task, revision: 2 });
    const projects = [
      makeProject({ id: "a", name: "Home" }),
      makeProject({ id: "b", name: "Old", status: "archived" }),
    ];
    setup({ task: { ...task, project_id: "a" }, projects });
    const select = screen.getByLabelText("Project") as HTMLSelectElement;
    expect(select).toHaveValue("a");
    expect(Array.from(select.options).map((o) => o.text)).toEqual([
      "No project",
      "Home",
    ]);

    fireEvent.change(select, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "t1" }),
        { project_id: null },
      ),
    );
  });

  it("saves with Ctrl+Enter", async () => {
    updateMock.mockResolvedValue({ ...task, revision: 2 });
    setup();
    fireEvent.change(screen.getByLabelText("Priority"), {
      target: { value: "urgent" },
    });
    fireEvent.keyDown(screen.getByLabelText("Title"), {
      key: "Enter",
      ctrlKey: true,
    });
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(task, { priority: "urgent" }),
    );
  });

  it("shows the server's validation message verbatim and keeps the edits", async () => {
    updateMock.mockRejectedValue(
      new ApiError(422, "title: String should have at least 1 character"),
    );
    setup();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "title: String should have at least 1 character",
    );
    expect(screen.getByLabelText("Title")).toHaveValue("");
  });

  it("shows a conflict for a stale revision instead of overwriting, and loads the latest on request", async () => {
    updateMock.mockRejectedValue(
      new ApiError(409, "task changed since it was read", {
        detail: {
          message: "task changed since it was read",
          current_revision: 5,
        },
      }),
    );
    getMock.mockResolvedValue({
      ...task,
      title: "Changed elsewhere",
      revision: 5,
    });
    const props = setup();

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "My edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(/changed somewhere else/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("My edit");

    fireEvent.click(
      screen.getByRole("button", { name: "Load latest version" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Title")).toHaveValue("Changed elsewhere"),
    );
    expect(props.onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 5 }),
    );
    expect(
      screen.queryByText(/changed somewhere else/i),
    ).not.toBeInTheDocument();
  });

  it("closes on Escape when nothing is unsaved", () => {
    const props = setup();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("asks before discarding unsaved edits", () => {
    const props = setup();
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Edited" },
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByText("You have unsaved changes.")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("deletes the task and reports it so the owner can offer undo", async () => {
    removeMock.mockResolvedValue(undefined);
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(props.onDeleted).toHaveBeenCalledWith(task));
    expect(removeMock).toHaveBeenCalledWith(task);
  });

  it("shows a failed delete and stays open", async () => {
    removeMock.mockRejectedValue(new Error("Not found"));
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not found");
    expect(props.onDeleted).not.toHaveBeenCalled();
  });
  it.each([
    ["Weekly", "FREQ=WEEKLY"],
    ["Daily", "FREQ=DAILY"],
    ["Monthly", "FREQ=MONTHLY"],
  ])(
    "repeats %s: shows the server's preview and saves only the rule",
    async (label, rule) => {
      vi.mocked(tasksApi.previewRecurrence).mockResolvedValue({
        occurrences: ["2026-11-03T09:30:00Z", "2026-11-10T09:30:00Z"],
      });
      updateMock.mockResolvedValue({
        ...task,
        recurrence_rule: rule,
        revision: 2,
      });
      setup();
      fireEvent.change(screen.getByLabelText("Repeat"), {
        target: { value: label.toLowerCase() },
      });
      const items = await screen.findAllByRole("listitem");
      expect(items.length).toBeGreaterThanOrEqual(2);
      expect(tasksApi.previewRecurrence).toHaveBeenCalledWith(
        rule,
        "2026-11-03T09:30:00",
        "UTC",
      );
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(updateMock).toHaveBeenCalledWith(task, {
          recurrence_rule: rule,
        }),
      );
    },
  );

  it("shows the server's message for a bad custom rule and cannot repeat without an anchor", async () => {
    vi.mocked(tasksApi.previewRecurrence).mockRejectedValue(
      new Error("invalid recurrence rule: 'FREQ=SOMETIMES'"),
    );
    setup();
    fireEvent.change(screen.getByLabelText("Repeat"), {
      target: { value: "custom" },
    });
    fireEvent.change(screen.getByLabelText("Custom rule"), {
      target: { value: "FREQ=SOMETIMES" },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "invalid recurrence rule: 'FREQ=SOMETIMES'",
    );
  });

  it("is read-only for an occurrence of a series and says so when no anchor is set", () => {
    setup({
      task: makeTask({
        id: "occ",
        recurrence_rule: "FREQ=DAILY",
        recurrence_parent_id: "head",
      }),
    });
    expect(screen.getByLabelText("Repeat")).toBeDisabled();
    expect(screen.getByText(/Set a due date or start/)).toBeInTheDocument();
  });

  it("completing a repeating task shows the next occurrence and can open it", async () => {
    const repeating = { ...task, recurrence_rule: "FREQ=DAILY" };
    const next = makeTask({
      id: "t2",
      title: task.title,
      recurrence_rule: "FREQ=DAILY",
      recurrence_parent_id: "t1",
      due_at: "2026-11-04T09:30:00Z",
      time_zone: "UTC",
    });
    vi.mocked(tasksApi.previewRecurrence).mockResolvedValue({
      occurrences: [],
    });
    updateMock.mockResolvedValue({
      ...repeating,
      status: "completed",
      revision: 2,
    });
    vi.mocked(tasksApi.list).mockResolvedValue({
      tasks: [{ ...repeating, status: "inbox" }, next],
    });
    const onOpenTask = vi.fn();
    setup({ task: repeating, onOpenTask });
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "completed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Next occurrence:/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Open next occurrence" }),
    );
    expect(onOpenTask).toHaveBeenCalledWith(next);
  });

  it("says the series ended when no further occurrence exists", async () => {
    const repeating = { ...task, recurrence_rule: "FREQ=DAILY;COUNT=1" };
    vi.mocked(tasksApi.previewRecurrence).mockResolvedValue({
      occurrences: [],
    });
    updateMock.mockResolvedValue({
      ...repeating,
      status: "completed",
      revision: 2,
    });
    vi.mocked(tasksApi.list).mockResolvedValue({ tasks: [] });
    setup({ task: repeating });
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "completed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/last occurrence/)).toBeInTheDocument();
  });
});
