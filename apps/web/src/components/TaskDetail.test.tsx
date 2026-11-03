import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";

import { ApiError, notificationsApi, tasksApi, type Task, type TaskFields } from "../api/client";
import { resetSessions } from "../lib/taskAutosave";
import { menuItem } from "../test/menu";
import { makeProject, makeTask } from "../test/tasks";
import { TaskDetail, type TaskPanelHandle } from "./TaskDetail";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ApiError: actual.ApiError,
    tasksApi: {
      update: vi.fn(),
      get: vi.fn(),
      remove: vi.fn(),
      list: vi.fn(),
      subtasks: vi.fn(),
      notes: vi.fn(),
      unlinkNote: vi.fn(),
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
  project_id: "a",
});

const projects = [
  makeProject({ id: "a", name: "Home" }),
  makeProject({ id: "b", name: "Garden" }),
  makeProject({ id: "c", name: "Old", status: "archived" }),
];

/** The server: applies each PATCH and bumps the revision. */
function serve(from: Task = task) {
  let current = from;
  updateMock.mockImplementation(async (base, fields: TaskFields) => {
    if (base.revision !== current.revision) {
      throw new ApiError(409, "stale", { detail: { current_revision: current.revision } });
    }
    current = { ...current, ...(fields as Partial<Task>), revision: current.revision + 1 };
    return current;
  });
  return () => current;
}

function setup(overrides: Partial<React.ComponentProps<typeof TaskDetail>> = {}) {
  const props = {
    task,
    timeZone: "UTC",
    projects,
    onClose: vi.fn(),
    onSaved: vi.fn(),
    onDeleted: vi.fn(),
    ...overrides,
  };
  const view = render(<TaskDetail {...props} />);
  return { props, view };
}

const dialog = () => screen.getByRole("dialog", { name: "Task details" });
const indicator = () => dialog().querySelector("[data-save-state]")!;
const property = (name: string) =>
  within(dialog()).getByRole("button", { name: new RegExp(`^${name}\\b`) });

async function chooseFrom(name: string, item: string) {
  fireEvent.click(property(name));
  fireEvent.click(menuItem(item));
}

beforeEach(() => {
  vi.resetAllMocks();
  resetSessions();
  getMock.mockResolvedValue(task);
  vi.mocked(tasksApi.subtasks).mockResolvedValue({ tasks: [] });
  vi.mocked(tasksApi.notes).mockResolvedValue({ notes: [] });
  vi.mocked(tasksApi.previewRecurrence).mockResolvedValue({ occurrences: [] } as never);
  vi.mocked(notificationsApi.taskReminder).mockResolvedValue({
    override: null,
    effective: null,
    remind_at: null,
  });
});

describe("TaskDetail (property panel with autosave)", () => {
  it("shows the task as properties, focuses the title and has no Save button", () => {
    setup();
    expect(dialog()).toBeInTheDocument();
    const title = screen.getByLabelText("Title");
    expect(title).toHaveValue("Buy milk");
    expect(title).toHaveFocus();
    expect(screen.getByLabelText("Description")).toHaveValue("Semi-skimmed");
    expect(property("Status")).toHaveTextContent("Inbox");
    expect(property("Priority")).toHaveTextContent("Low");
    expect(property("Project")).toHaveTextContent("Home");
    expect(property("Time zone")).toHaveTextContent("UTC");
    expect(screen.getByLabelText("Due date")).toHaveValue("2026-11-03");
    expect(screen.getByLabelText("Due time")).toHaveValue("09:30");
    expect(within(screen.getByRole("list", { name: "Tags" })).getByText("#home")).toBeVisible();
    expect(within(dialog()).queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(indicator()).toHaveTextContent("Saved");
  });

  it.each([
    ["Status", "In progress", { status: "in_progress" }],
    ["Priority", "Urgent", { priority: "urgent" }],
    ["Priority", "No priority", { priority: "none" }],
    ["Project", "Garden", { project_id: "b" }],
    ["Project", "No project", { project_id: null }],
  ])("choosing %s → %s saves just that field at once", async (name, item, fields) => {
    serve();
    const { props } = setup();
    await chooseFrom(name, item);
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "t1", revision: 1 }),
        fields,
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      ),
    );
    await waitFor(() => expect(indicator()).toHaveTextContent("Saved"));
    expect(props.onSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
  });

  it("offers archived projects only while the task is in one, and only allowed status moves", () => {
    setup({ task: makeTask({ id: "t2", status: "completed" }) });
    fireEvent.click(property("Project"));
    const menu = screen.getByRole("menu", { name: "Project" });
    expect(within(menu).getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual([
      "No project",
      "Home",
      "Garden",
    ]);
    fireEvent.keyDown(menu, { key: "Escape" });
    fireEvent.click(property("Status"));
    const disabled = within(screen.getByRole("menu", { name: "Status" }))
      .getAllByRole("menuitemradio")
      .filter((item) => item.getAttribute("aria-disabled") === "true")
      .map((item) => item.textContent);
    expect(disabled).toEqual(["Inbox", "Next"]);
  });

  it("saves typed text when the field is left, and Enter in the title does not add a line", async () => {
    serve();
    setup();
    const title = screen.getByLabelText("Title");
    fireEvent.change(title, { target: { value: "Buy oat milk" } });
    expect(indicator()).toHaveTextContent("Saving…");
    fireEvent.keyDown(title, { key: "Enter" });
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        expect.anything(),
        { title: "Buy oat milk" },
        expect.anything(),
      ),
    );
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Two litres" } });
    fireEvent.blur(screen.getByLabelText("Description"));
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(2));
    expect(updateMock.mock.calls[1][0].revision).toBe(2);
    expect(updateMock.mock.calls[1][1]).toEqual({ description: "Two litres" });
    await waitFor(() => expect(indicator()).toHaveTextContent("Saved"));
  });

  it.each([
    ["Enter"],
    ["s"],
  ])("Ctrl+%s saves pending text at once (no need to, but allowed)", async (key) => {
    serve();
    setup();
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Now" } });
    fireEvent.keyDown(screen.getByLabelText("Description"), { key, ctrlKey: true });
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(expect.anything(), { description: "Now" }, expect.anything()),
    );
  });

  it("shows a 422 verbatim on its field and keeps the text (no revert)", async () => {
    updateMock.mockRejectedValue(
      new ApiError(422, "title: String should have at least 1 character"),
    );
    setup();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "" } });
    fireEvent.blur(screen.getByLabelText("Title"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "title: String should have at least 1 character",
    );
    expect(screen.getByLabelText("Title")).toHaveValue("");
    expect(indicator()).toHaveTextContent("Not saved");
  });

  it("a stale edit shows the conflict, keeps the local value, and loads the latest on request", async () => {
    const latest = { ...task, title: "Changed elsewhere", revision: 2 };
    updateMock.mockRejectedValue(
      new ApiError(409, "conflict", { detail: { current_revision: 2 } }),
    );
    getMock.mockResolvedValue(latest);
    const { props } = setup();
    await chooseFrom("Priority", "Urgent");

    expect(await screen.findByText(/changed somewhere else/i)).toBeInTheDocument();
    expect(indicator()).toHaveTextContent("Conflict");
    expect(property("Priority")).toHaveTextContent("Urgent");
    expect(updateMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Load latest version" }));
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Changed elsewhere"));
    expect(property("Priority")).toHaveTextContent("Low");
    expect(props.onSaved).toHaveBeenCalledWith(latest);
    expect(screen.getByText(/set aside: priority “urgent”/i)).toBeInTheDocument();

    // Reapplying sends the set-aside value against the latest revision.
    serve(latest);
    fireEvent.click(screen.getByRole("button", { name: "Reapply my changes" }));
    await waitFor(() =>
      expect(updateMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ revision: 2 }),
        { priority: "urgent" },
        expect.anything(),
      ),
    );
  });

  it("Esc saves pending text first, then closes", async () => {
    serve();
    const { props } = setup();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Typed then closed" } });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
    expect(updateMock).toHaveBeenCalledWith(
      expect.anything(),
      { title: "Typed then closed" },
      expect.anything(),
    );
  });

  it("does not close with an unsaved edit; it warns and discards only on request", async () => {
    updateMock.mockRejectedValue(new ApiError(422, "title: too long"));
    const { props } = setup();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "x".repeat(600) } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    expect(await screen.findByText(/not saved yet: Title/)).toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard and close" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("the owner's guard (switching task) saves first", async () => {
    serve();
    const handle = createRef<TaskPanelHandle | null>() as React.MutableRefObject<TaskPanelHandle | null>;
    setup({ handle });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Switch" } });
    const action = vi.fn();
    act(() => handle.current!.guard(action));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("deletes from the … menu after saving pending edits, so undo restores them", async () => {
    serve();
    removeMock.mockResolvedValue(undefined);
    const { props } = setup();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Last words" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Task options" }));
    fireEvent.click(menuItem("Delete task"));
    await waitFor(() => expect(props.onDeleted).toHaveBeenCalled());
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Last words", revision: 2 }));
  });

  it("shows a failed delete and stays open", async () => {
    removeMock.mockRejectedValue(new Error("Not found"));
    const { props } = setup();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Task options" }));
    fireEvent.click(menuItem("Delete task"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not found");
    expect(props.onDeleted).not.toHaveBeenCalled();
  });

  it("adds tags on Enter and removes one with its button", async () => {
    serve();
    setup();
    fireEvent.change(screen.getByLabelText("Add a tag"), { target: { value: "work" } });
    fireEvent.keyDown(screen.getByLabelText("Add a tag"), { key: "Enter" });
    await waitFor(() =>
      expect(updateMock).toHaveBeenLastCalledWith(expect.anything(), { tags: ["home", "work"] }, expect.anything()),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Remove tag home" }));
    await waitFor(() =>
      expect(updateMock).toHaveBeenLastCalledWith(expect.anything(), { tags: ["work"] }, expect.anything()),
    );
  });

  it.each([
    ["Tokyo", "Asia/Tokyo"],
    ["Mars/Olympus", "Mars/Olympus"],
  ])("time zone: searching %s and pressing Enter saves %s", async (query, zone) => {
    serve();
    setup();
    fireEvent.click(property("Time zone"));
    const search = screen.getByRole("combobox", { name: "Search time zones" });
    fireEvent.change(search, { target: { value: query } });
    fireEvent.keyDown(search, { key: "ArrowDown" }); // past "Use my time zone"
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ time_zone: zone }),
        expect.anything(),
      ),
    );
  });

  it.each([
    ["weekly", "FREQ=WEEKLY"],
    ["daily", "FREQ=DAILY"],
    ["monthly", "FREQ=MONTHLY"],
  ])("repeat %s saves only the rule at once", async (choice, rule) => {
    serve();
    setup();
    fireEvent.change(screen.getByLabelText("Repeat"), { target: { value: choice } });
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(expect.anything(), { recurrence_rule: rule }, expect.anything()),
    );
  });

  it("a bad custom rule is sent only when the field is left; the server's message is shown", async () => {
    updateMock.mockRejectedValue(new ApiError(422, "recurrence_rule: invalid recurrence rule"));
    setup();
    fireEvent.change(screen.getByLabelText("Repeat"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Custom rule"), { target: { value: "FREQ=SOMETIMES" } });
    expect(updateMock).not.toHaveBeenCalled();
    fireEvent.blur(screen.getByLabelText("Custom rule"));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid recurrence rule");
    expect(screen.getByLabelText("Custom rule")).toHaveValue("FREQ=SOMETIMES");
  });

  it("an occurrence of a series shows its rule read-only", () => {
    setup({ task: makeTask({ id: "t3", recurrence_rule: "FREQ=DAILY", recurrence_parent_id: "head" }) });
    expect(screen.getByLabelText("Repeat")).toBeDisabled();
    expect(screen.getByText(/Set a due date or start/)).toBeInTheDocument();
  });

  it("completing a repeating task shows the next occurrence and opens it after saving", async () => {
    const repeating = { ...task, recurrence_rule: "FREQ=DAILY" };
    serve(repeating);
    const next = makeTask({ id: "t9", title: "Buy milk", recurrence_parent_id: "t1", due_at: "2026-11-04T09:30:00Z" });
    vi.mocked(tasksApi.list).mockResolvedValue({ tasks: [next] } as never);
    const onOpenTask = vi.fn();
    setup({ task: repeating, onOpenTask });
    await chooseFrom("Status", "Completed");
    expect(await screen.findByText(/Next occurrence:/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open next occurrence" }));
    await waitFor(() => expect(onOpenTask).toHaveBeenCalledWith(next));
  });

  it("says the series ended when no further occurrence exists", async () => {
    const repeating = { ...task, recurrence_rule: "FREQ=DAILY;COUNT=1" };
    serve(repeating);
    vi.mocked(tasksApi.list).mockResolvedValue({ tasks: [] } as never);
    setup({ task: repeating });
    await chooseFrom("Status", "Completed");
    expect(await screen.findByText(/last occurrence/)).toBeInTheDocument();
  });
});

describe("TaskDetail as an overlay (below 1280 px)", () => {
  const original = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = original;
  });

  it("is modal with a scrim that closes it, and Tab stays inside", async () => {
    const { props, view } = setup();
    expect(dialog()).toHaveAttribute("aria-modal", "true");
    // Shift+Tab from the first control wraps to the last one.
    const first = dialog().querySelectorAll<HTMLElement>("button, input, textarea, select")[0];
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).not.toBe(first);
    expect(dialog().contains(document.activeElement)).toBe(true);
    fireEvent.click(view.container.querySelector(".task-detail-scrim")!);
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  });
});
