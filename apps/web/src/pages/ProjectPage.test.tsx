import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { notesApi, projectsApi, tasksApi } from "../api/client";
import { makeProject, makeTask } from "../test/tasks";
import { ProjectPage } from "./ProjectPage";

vi.mock("../api/client", () => ({
  tasksApi: {
    list: vi.fn(),
    create: vi.fn(),
    complete: vi.fn(),
    setStatus: vi.fn(),
  },
  projectsApi: {
    get: vi.fn(),
    notes: vi.fn(),
    update: vi.fn(),
    linkNote: vi.fn(),
    unlinkNote: vi.fn(),
  },
  notesApi: { list: vi.fn() },
}));

const project = makeProject({
  id: "p1",
  name: "Garden",
  description: "Make it bloom",
  progress: { total: 2, completed: 1, percent: 50 },
});
const note = {
  id: "n1",
  path: "garden/plan.md",
  title: "Plan",
  revision: 1,
  content_hash: "x",
  size_bytes: 1,
};

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/projects/p1"]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(projectsApi.get).mockResolvedValue(project);
  vi.mocked(projectsApi.notes).mockResolvedValue({ notes: [note] });
  vi.mocked(notesApi.list).mockResolvedValue({
    notes: [note, { ...note, id: "n2", path: "other.md", title: "Other" }],
    folders: [],
  });
  vi.mocked(tasksApi.list).mockResolvedValue({
    tasks: [
      makeTask({ id: "t1", title: "Dig", status: "next", project_id: "p1" }),
    ],
  });
});

describe("ProjectPage", () => {
  it("shows description, derived progress, tasks of this project only, and linked notes", async () => {
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "Garden" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Make it bloom")).toBeInTheDocument();
    expect(screen.getByText("1/2 done · 50%")).toBeInTheDocument();
    expect(await screen.findByText("Dig")).toBeInTheDocument();
    expect(vi.mocked(tasksApi.list)).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1" }),
    );
    expect(screen.getByText("garden/plan.md")).toBeInTheDocument();
  });

  it("adds a task to the project, switches to the board, and archives", async () => {
    vi.mocked(tasksApi.create).mockResolvedValue(makeTask());
    vi.mocked(projectsApi.update).mockResolvedValue({
      ...project,
      status: "archived",
    });
    renderPage();
    await screen.findByText("Dig");

    fireEvent.change(screen.getByLabelText("Task title"), {
      target: { value: "Water" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(tasksApi.create).toHaveBeenCalledWith("Water", {
        project_id: "p1",
        status: "next",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(
      await screen.findByRole("button", { name: "Actions for Dig" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Archive project" }));
    expect(
      await screen.findByRole("button", { name: "Restore project" }),
    ).toBeInTheDocument();
  });

  // UX-03 regression: completed tasks used to show a "Complete" button. They now show a checked
  // round checkbox, and unchecking it reopens the task through the server transition.
  it.each([
    ["next", false, "complete"],
    ["completed", true, "setStatus"],
  ] as const)("a %s task shows checked=%s and toggling it calls %s", async (status, checked, call) => {
    const task = makeTask({ id: "t2", title: "Plant", status, project_id: "p1" });
    vi.mocked(tasksApi.list).mockResolvedValue({ tasks: [task] });
    vi.mocked(tasksApi.complete).mockResolvedValue(task);
    vi.mocked(tasksApi.setStatus).mockResolvedValue(task);
    renderPage();

    const box = await screen.findByRole("checkbox", { name: "Complete Plant" });
    expect(box).toHaveProperty("checked", checked);
    expect(screen.queryByRole("button", { name: /^Complete/ })).not.toBeInTheDocument();
    fireEvent.click(box);

    if (call === "complete") {
      await waitFor(() => expect(tasksApi.complete).toHaveBeenCalledWith(task));
    } else {
      await waitFor(() => expect(tasksApi.setStatus).toHaveBeenCalledWith(task, "in_progress"));
    }
  });

  it("links and unlinks notes", async () => {
    vi.mocked(projectsApi.linkNote).mockResolvedValue(undefined);
    vi.mocked(projectsApi.unlinkNote).mockResolvedValue(undefined);
    renderPage();
    fireEvent.change(await screen.findByLabelText("Link a note"), {
      target: { value: "n2" },
    });
    await waitFor(() =>
      expect(projectsApi.linkNote).toHaveBeenCalledWith("p1", "n2"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Unlink garden/plan.md" }),
    );
    await waitFor(() =>
      expect(projectsApi.unlinkNote).toHaveBeenCalledWith("p1", "n1"),
    );
  });
});
