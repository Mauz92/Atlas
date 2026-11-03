import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { notesApi, projectsApi, tasksApi } from "../api/client";
import { choose } from "../test/menu";
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

function renderPage(url = "/projects/p1") {
  render(
    <MemoryRouter initialEntries={[url]}>
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
    // The linked notes are on their own tab.
    expect(screen.queryByText("garden/plan.md")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByText("garden/plan.md")).toBeInTheDocument();
  });

  it("shows the header with status, dates in one format and tabs; completed tasks fold", async () => {
    vi.mocked(projectsApi.get).mockResolvedValue({ ...project, start_date: "2031-01-02", target_date: "2031-02-03" });
    vi.mocked(tasksApi.list).mockResolvedValue({
      tasks: [
        makeTask({ id: "t1", title: "Dig", status: "next", project_id: "p1" }),
        makeTask({ id: "t2", title: "Plant", status: "completed", project_id: "p1" }),
        makeTask({ id: "t3", title: "Shed", status: "archived", project_id: "p1" }),
      ],
    });
    renderPage();
    expect(await screen.findByRole("heading", { name: "Garden" })).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/^Starts .*Jan.*2031/)).toBeInTheDocument();
    expect(screen.getByText(/^Target .*Feb.*2031/)).toBeInTheDocument();
    expect(screen.queryByText(/2031-01-02/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Tasks", "Board", "Notes"]);

    expect(await screen.findByText("Dig")).toBeInTheDocument();
    expect(screen.queryByText("Plant")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Completed (1)" }));
    expect(screen.getByRole("checkbox", { name: "Complete Plant" })).toBeChecked();
    expect(screen.queryByText("Shed")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archived (1)" }));
    expect(screen.getByText("Shed")).toBeInTheDocument();
  });

  it("moves between tabs with the arrow keys and remembers the tab in the URL", async () => {
    renderPage("/projects/p1?tab=board");
    const board = await screen.findByRole("tab", { name: "Board" });
    expect(board).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(board, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Notes" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Notes" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Tasks" })).toHaveAttribute("aria-selected", "true");
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

    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    expect(
      await screen.findByRole("button", { name: "Actions for Dig" }),
    ).toBeInTheDocument();

    await choose("Project options", "Archive project");
    fireEvent.click(await screen.findByRole("button", { name: "Project options" }));
    expect(await screen.findByRole("menuitem", { name: "Restore project" })).toBeInTheDocument();
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
    // Completed tasks are folded into a group (UX-07).
    if (status === "completed") fireEvent.click(await screen.findByRole("button", { name: "Completed (1)" }));

    const box = await screen.findByRole("checkbox", { name: "Complete Plant" });
    expect(box).toHaveProperty("checked", checked);
    expect(screen.queryByRole("button", { name: /^Complete / })).not.toBeInTheDocument();
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
    renderPage("/projects/p1?tab=notes");
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
