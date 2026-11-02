import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { tasksApi } from "../api/client";
import { makeTask } from "../test/tasks";
import { TaskSubtasks } from "./TaskSubtasks";

vi.mock("../api/client", () => ({
  tasksApi: {
    subtasks: vi.fn(),
    get: vi.fn(),
    addSubtask: vi.fn(),
    complete: vi.fn(),
    remove: vi.fn(),
  },
}));

const parent = makeTask({ id: "p", title: "Parent" });
const open = makeTask({ id: "s1", title: "Pack bags", parent_task_id: "p" });
const done = makeTask({
  id: "s2",
  title: "Book taxi",
  parent_task_id: "p",
  status: "completed",
});

function setup(openDisabled = false) {
  const props = { onOpen: vi.fn(), onChanged: vi.fn() };
  render(
    <TaskSubtasks parent={parent} openDisabled={openDisabled} {...props} />,
  );
  return props;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(tasksApi.subtasks).mockResolvedValue({ tasks: [open, done] });
  vi.mocked(tasksApi.get).mockResolvedValue({
    ...parent,
    subtasks_total: 2,
    subtasks_done: 1,
  });
});

describe("TaskSubtasks", () => {
  it("lists subtasks with the server's progress and opens one", async () => {
    const props = setup();
    expect(await screen.findByText("Pack bags")).toBeInTheDocument();
    expect(screen.getByText(/1\/2 done/)).toBeInTheDocument();
    expect(screen.getByLabelText("Complete Book taxi")).toBeChecked();
    fireEvent.click(
      screen.getByRole("button", { name: "Open subtask Pack bags" }),
    );
    expect(props.onOpen).toHaveBeenCalledWith(open);
  });

  it("does not open a subtask while the parent has unsaved edits", async () => {
    setup(true);
    await screen.findByText("Pack bags");
    expect(
      screen.getByRole("button", { name: "Open subtask Pack bags" }),
    ).toBeDisabled();
  });

  it.each([
    [
      "adds",
      async () => {
        vi.mocked(tasksApi.addSubtask).mockResolvedValue(makeTask());
        fireEvent.change(screen.getByLabelText("New subtask"), {
          target: { value: " Buy tickets " },
        });
        fireEvent.click(screen.getByRole("button", { name: "Add subtask" }));
        await waitFor(() =>
          expect(tasksApi.addSubtask).toHaveBeenCalledWith("p", "Buy tickets"),
        );
      },
    ],
    [
      "completes",
      async () => {
        vi.mocked(tasksApi.complete).mockResolvedValue(makeTask());
        fireEvent.click(screen.getByLabelText("Complete Pack bags"));
        await waitFor(() =>
          expect(tasksApi.complete).toHaveBeenCalledWith(open),
        );
      },
    ],
    [
      "removes",
      async () => {
        vi.mocked(tasksApi.remove).mockResolvedValue(undefined);
        fireEvent.click(
          screen.getByRole("button", { name: "Remove Pack bags" }),
        );
        await waitFor(() => expect(tasksApi.remove).toHaveBeenCalledWith(open));
      },
    ],
  ])(
    "%s a subtask, reloads and tells the lists to refresh",
    async (_name, act) => {
      const props = setup();
      await screen.findByText("Pack bags");
      await act();
      await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
      expect(tasksApi.subtasks).toHaveBeenCalledTimes(2);
    },
  );

  it("shows the server's message when a change fails", async () => {
    vi.mocked(tasksApi.complete).mockRejectedValue(
      new Error("task changed since it was read"),
    );
    setup();
    await screen.findByText("Pack bags");
    fireEvent.click(screen.getByLabelText("Complete Pack bags"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "task changed since it was read",
    );
  });
});
