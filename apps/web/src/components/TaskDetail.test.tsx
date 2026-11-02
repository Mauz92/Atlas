import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ApiError, tasksApi } from "../api/client";
import { makeTask } from "../test/tasks";
import { TaskDetail } from "./TaskDetail";

vi.mock("../api/client", async () => {
  const actual =
    await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ApiError: actual.ApiError,
    tasksApi: { update: vi.fn(), get: vi.fn(), remove: vi.fn() },
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
});
