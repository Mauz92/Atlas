import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { notesApi, projectsApi, tasksApi, type NoteDetail } from "../api/client";
import { makeTask } from "../test/tasks";
import { Notes } from "./Notes";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ApiError: actual.ApiError,
    notesApi: { list: vi.fn(), get: vi.fn(), createTask: vi.fn() },
    tasksApi: { get: vi.fn() },
    projectsApi: { list: vi.fn() },
  };
});

const openTask = vi.fn();
vi.mock("../hooks/useTaskEditor", () => ({
  useTaskEditor: () => ({ open: openTask, remove: vi.fn(), error: null, overlays: null }),
}));

// CodeMirror needs real layout; the selection contract is what the page relies on.
vi.mock("../components/NoteEditor", () => ({
  NoteEditor: ({
    ref,
    value,
  }: {
    ref: React.RefObject<{ selectionOrLine: () => string } | null>;
    value: string;
  }) => {
    ref.current = { selectionOrLine: () => "- [ ] Call the plumber" };
    return <pre data-testid="note-editor">{value}</pre>;
  },
}));

const summary = {
  id: "n1",
  path: "Home/Repairs.md",
  title: "Repairs",
  revision: 3,
  content_hash: "h",
  size_bytes: 10,
};

function detail(overrides: Partial<NoteDetail> = {}): NoteDetail {
  return {
    ...summary,
    content: "# Repairs\n- [ ] Call the plumber\n",
    tags: [],
    links: [],
    backlinks: [],
    unresolved_links: [],
    tasks: [],
    projects: [],
    ...overrides,
  };
}

async function openNote() {
  render(
    <MemoryRouter initialEntries={["/notes?open=n1"]}>
      <Notes />
    </MemoryRouter>,
  );
  await screen.findByText(/Home\/Repairs.md · revision 3/);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(notesApi.list).mockResolvedValue({ notes: [summary], folders: ["Home"] });
  vi.mocked(projectsApi.list).mockResolvedValue({ projects: [] });
});

describe("Notes: tasks and projects linked to the note", () => {
  it("lists linked notes, tasks and projects as backlinks, and opens a task", async () => {
    vi.mocked(notesApi.get).mockResolvedValue(
      detail({
        backlinks: [{ ...summary, id: "n2", path: "Index.md" }],
        tasks: [
          {
            id: "t1",
            title: "Call the plumber",
            status: "next",
            priority: "none",
            due_at: null,
            project_id: null,
          },
        ],
        projects: [{ id: "p1", name: "House", status: "active" }],
      }),
    );
    vi.mocked(tasksApi.get).mockResolvedValue(makeTask({ id: "t1", title: "Call the plumber" }));
    await openNote();

    expect(within(screen.getByRole("list", { name: "Linked notes" })).getByText("Index.md")).toBeVisible();
    const tasks = screen.getByRole("list", { name: "Linked tasks" });
    expect(within(tasks).getByText(/Next/)).toBeVisible();
    expect(
      within(screen.getByRole("list", { name: "Linked projects" })).getByRole("link", { name: "House" }),
    ).toHaveAttribute("href", "/projects/p1");
    fireEvent.click(within(tasks).getByRole("button", { name: "Call the plumber" }));
    await waitFor(() => expect(openTask).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" })));
  });
});

describe("Notes: task from selection", () => {
  it("proposes a clean title, files into the note's only project and refreshes the lists", async () => {
    const project = { id: "p1", name: "House", status: "active" as const };
    vi.mocked(notesApi.get).mockResolvedValueOnce(detail({ projects: [project] }));
    vi.mocked(notesApi.createTask).mockResolvedValue(makeTask({ id: "t9", title: "Call the plumber" }));
    await openNote();

    fireEvent.click(screen.getByRole("button", { name: "Task from selection" }));
    const form = screen.getByRole("form", { name: "New task from note" });
    expect(within(form).getByLabelText("Task title")).toHaveValue("Call the plumber");
    expect(form).toHaveTextContent("Will be filed in “House”");

    vi.mocked(notesApi.get).mockResolvedValueOnce(
      detail({
        projects: [project],
        tasks: [
          { id: "t9", title: "Call the plumber", status: "inbox", priority: "none", due_at: null, project_id: "p1" },
        ],
      }),
    );
    fireEvent.change(within(form).getByLabelText("Task title"), { target: { value: " Call the plumber today " } });
    fireEvent.click(within(form).getByRole("button", { name: "Create task" }));

    await waitFor(() =>
      expect(notesApi.createTask).toHaveBeenCalledWith("n1", "Call the plumber today", { project_id: "p1" }),
    );
    expect(await screen.findByRole("list", { name: "Linked tasks" })).toBeVisible();
    expect(screen.queryByRole("form", { name: "New task from note" })).toBeNull();
  });

  it("keeps the form open and shows the server's message verbatim on failure", async () => {
    vi.mocked(notesApi.get).mockResolvedValue(detail());
    vi.mocked(notesApi.createTask).mockRejectedValue(new Error("String should have at most 512 characters"));
    await openNote();
    fireEvent.click(screen.getByRole("button", { name: "Task from selection" }));
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("String should have at most 512 characters");
    expect(notesApi.createTask).toHaveBeenCalledWith("n1", "Call the plumber", {});
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "New task from note" })).toBeNull();
  });
});
