import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { projectsApi, tasksApi } from "../api/client";
import { makeProject, makeTask } from "../test/tasks";
import { Inbox } from "./Inbox";

vi.mock("../api/client", () => ({
  tasksApi: {
    list: vi.fn(),
    create: vi.fn(),
    complete: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    restore: vi.fn(),
    get: vi.fn(),
  },
  projectsApi: { list: vi.fn() },
}));

const listMock = vi.mocked(tasksApi.list);
const createMock = vi.mocked(tasksApi.create);

const updateMock = vi.mocked(tasksApi.update);
const removeMock = vi.mocked(tasksApi.remove);
const restoreMock = vi.mocked(tasksApi.restore);
const projectsMock = vi.mocked(projectsApi.list);

beforeEach(() => {
  vi.resetAllMocks();
  projectsMock.mockResolvedValue({
    projects: [makeProject({ id: "p1", name: "Home" })],
  });
});

describe("Inbox", () => {
  it("renders the inbox tasks returned by the API", async () => {
    listMock.mockResolvedValue({
      tasks: [
        makeTask({ id: "a", title: "Call the vet" }),
        makeTask({ id: "b", title: "Book flights", priority: "high" }),
      ],
    });

    render(<Inbox />);

    expect(await screen.findByText("Call the vet")).toBeInTheDocument();
    expect(screen.getByText("Book flights")).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ view: "inbox" }),
    );
  });

  it("shows a useful empty state", async () => {
    listMock.mockResolvedValue({ tasks: [] });

    render(<Inbox />);

    expect(await screen.findByText(/Inbox zero/i)).toBeInTheDocument();
  });

  it("shows a clear error when loading fails", async () => {
    listMock.mockRejectedValueOnce(new Error("Bad gateway"));

    render(<Inbox />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Bad gateway");
  });

  it("quick-captures a task with a title only", async () => {
    listMock.mockResolvedValue({ tasks: [] });
    createMock.mockResolvedValue(
      makeTask({ id: "new", title: "Water plants" }),
    );

    render(<Inbox />);
    await screen.findByText(/Inbox zero/i);

    fireEvent.change(screen.getByLabelText("Task title"), {
      target: { value: "Water plants" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith("Water plants"),
    );
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("schedules a row for today: next status and a date-only due, then refreshes", async () => {
    const task = makeTask({ id: "a", title: "Call the vet" });
    listMock
      .mockResolvedValueOnce({ tasks: [task] })
      .mockResolvedValue({ tasks: [] });
    updateMock.mockResolvedValue(makeTask({ ...task, status: "next" }));

    render(<Inbox />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Schedule Call the vet for today",
      }),
    );

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        task,
        expect.objectContaining({
          status: "next",
          due_at: expect.stringMatching(/T23:59:00$/),
        }),
      ),
    );
    expect(await screen.findByText(/Inbox zero/i)).toBeInTheDocument();
  });

  it("schedules a row for a picked date", async () => {
    const task = makeTask({ id: "a", title: "Call the vet" });
    listMock.mockResolvedValue({ tasks: [task] });
    updateMock.mockResolvedValue(makeTask({ ...task, status: "next" }));

    render(<Inbox />);
    fireEvent.change(
      await screen.findByLabelText("Pick a date for Call the vet"),
      {
        target: { value: "2031-03-04" },
      },
    );

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(
        task,
        expect.objectContaining({
          status: "next",
          due_at: "2031-03-04T23:59:00",
        }),
      ),
    );
  });

  it("files a row to a project", async () => {
    const task = makeTask({ id: "a", title: "Call the vet" });
    listMock.mockResolvedValue({ tasks: [task] });
    updateMock.mockResolvedValue(
      makeTask({ ...task, status: "next", project_id: "p1" }),
    );

    render(<Inbox />);
    await screen.findByRole("option", { name: "Home" });
    fireEvent.change(screen.getByLabelText("File Call the vet to a project"), {
      target: { value: "p1" },
    });

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(task, {
        status: "next",
        project_id: "p1",
      }),
    );
  });

  it("shows the server's message verbatim when a triage action is rejected", async () => {
    const task = makeTask({ id: "a", title: "Call the vet" });
    listMock.mockResolvedValue({ tasks: [task] });
    updateMock.mockRejectedValue(
      new Error("due_at: Input should be a valid datetime"),
    );

    render(<Inbox />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Schedule Call the vet for today",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "due_at: Input should be a valid datetime",
    );
    expect(screen.getByText("Call the vet")).toBeInTheDocument();
  });

  it("deletes a row and offers an undo that restores it", async () => {
    const task = makeTask({ id: "a", title: "Call the vet" });
    listMock
      .mockResolvedValueOnce({ tasks: [task] })
      .mockResolvedValueOnce({ tasks: [] });
    removeMock.mockResolvedValue(undefined);
    restoreMock.mockResolvedValue(task);

    render(<Inbox />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete Call the vet" }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Deleted “Call the vet”",
    );
    expect(removeMock).toHaveBeenCalledWith(task);

    listMock.mockResolvedValue({ tasks: [task] });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    await waitFor(() => expect(restoreMock).toHaveBeenCalledWith("a"));
    expect(await screen.findByText("Call the vet")).toBeInTheDocument();
  });
});
