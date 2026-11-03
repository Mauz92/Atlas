import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { ApiError, notesApi, projectsApi, tasksApi, type NoteDetail } from "../api/client";
import { noteSessions } from "../hooks/useNoteAutosave";
import { localDate } from "../lib/taskForm";
import { choose } from "../test/menu";
import { makeTask } from "../test/tasks";
import { Notes } from "./Notes";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ApiError: actual.ApiError,
    notesApi: {
      list: vi.fn(),
      get: vi.fn(),
      createTask: vi.fn(),
      openDaily: vi.fn(),
      createFromTemplate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      saveConflictCopy: vi.fn(),
      move: vi.fn(),
      remove: vi.fn(),
      createFolder: vi.fn(),
      renameFolder: vi.fn(),
      removeFolder: vi.fn(),
      search: vi.fn(),
      reconcile: vi.fn(),
    },
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
    onChange,
  }: {
    ref: React.RefObject<{ selectionOrLine: () => string; focus: () => void } | null>;
    value: string;
    onChange: (text: string) => void;
  }) => {
    ref.current = { selectionOrLine: () => "- [ ] Call the plumber", focus: () => undefined };
    return (
      <textarea
        data-testid="note-editor"
        aria-label="Note content"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
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
  // The header shows the path and the save state; the revision is only in the tooltip (UX-01).
  expect(await screen.findByTitle("Revision 3")).toHaveTextContent("Home/Repairs.md");
  expect(screen.getByText("Saved")).toBeInTheDocument();
}

beforeEach(() => {
  vi.resetAllMocks();
  noteSessions.clear();
  localStorage.clear();
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

    await choose("Note options", "Task from selection");
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
    await choose("Note options", "Task from selection");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("String should have at most 512 characters");
    expect(notesApi.createTask).toHaveBeenCalledWith("n1", "Call the plumber", {});
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "New task from note" })).toBeNull();
  });
});

describe("Notes: daily note and templates", () => {
  const template = {
    ...summary,
    id: "tpl",
    path: "templates/Meeting.md",
    title: "Meeting",
  };

  function renderNotes(url = "/notes") {
    render(
      <MemoryRouter initialEntries={[url]}>
        <Notes />
      </MemoryRouter>,
    );
  }

  it("opens today's note for the viewer's calendar day", async () => {
    vi.mocked(notesApi.openDaily).mockResolvedValue(
      detail({ id: "d1", path: `daily/${localDate()}.md`, content: "# Day\n" }),
    );
    renderNotes();
    fireEvent.click(await screen.findByRole("button", { name: "Today's note" }));
    expect(await screen.findByTitle("Revision 3")).toHaveTextContent(
      `daily/${localDate()}.md`,
    );
    expect(notesApi.openDaily).toHaveBeenCalledWith(localDate());
  });

  it("offers only templates/ notes, creates from one, and shows server errors verbatim", async () => {
    vi.mocked(notesApi.list).mockResolvedValue({ notes: [summary, template], folders: [] });
    vi.mocked(notesApi.createFromTemplate)
      .mockRejectedValueOnce(new Error("A note or folder already exists there"))
      .mockResolvedValueOnce(detail({ id: "new", path: "Work/Standup.md", content: "# Standup\n" }));
    renderNotes("/notes?new=template");

    // The palette's link opens the template menu by itself; only templates/ notes are listed.
    const menu = await screen.findByRole("menu", { name: "New from template" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Meeting"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Meeting" }));

    const name = screen.getByRole("textbox", { name: "Name for the new note from Meeting" });
    fireEvent.change(name, { target: { value: "Work/Standup" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(await screen.findByText("A note or folder already exists there")).toBeInTheDocument();

    await choose("New from template", "Meeting");
    const again = screen.getByRole("textbox", { name: "Name for the new note from Meeting" });
    fireEvent.change(again, { target: { value: "Work/Standup" } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(await screen.findByTitle("Revision 3")).toHaveTextContent("Work/Standup.md");
    expect(notesApi.createFromTemplate).toHaveBeenLastCalledWith("Work/Standup", "tpl", localDate());
  });

  it("explains when there are no templates", async () => {
    renderNotes();
    await choose("New from template");
    expect(screen.getByRole("menuitem", { name: /No templates/ })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("Notes: loading the list", () => {
  it("shows the server's message with a retry when the first read fails", async () => {
    vi.mocked(notesApi.list).mockRejectedValueOnce(new Error("Notes folder is not readable"));
    render(
      <MemoryRouter initialEntries={["/notes"]}>
        <Notes />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Notes folder is not readable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByText("Loading notes…")).toBeNull();
  });
});

describe("Notes: autosave (UX-05)", () => {
  async function openAndType(text: string) {
    vi.mocked(notesApi.get).mockResolvedValue(detail());
    await openNote();
    fireEvent.change(screen.getByRole("textbox", { name: "Note content" }), { target: { value: text } });
  }

  it("has no Save button, saves after a pause and says so", async () => {
    await openAndType("# Repairs\nnew line");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText("Not saved yet")).toBeInTheDocument();
    vi.mocked(notesApi.update).mockResolvedValue(detail({ revision: 4, content: "# Repairs\nnew line" }));
    await waitFor(
      () => expect(notesApi.update).toHaveBeenCalledWith("n1", "# Repairs\nnew line", 3, { keepalive: false }),
      { timeout: 3000 },
    );
    expect(await screen.findByTitle("Revision 4")).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(localStorage.getItem("atlas:note-draft:n1")).toBeNull();
  });

  it("Ctrl+S saves now, and a draft is on this device until the server confirms", async () => {
    await openAndType("# Repairs\nsooner");
    expect(JSON.parse(localStorage.getItem("atlas:note-draft:n1")!)).toMatchObject({
      content: "# Repairs\nsooner",
      baseRevision: 3,
    });
    vi.mocked(notesApi.update).mockResolvedValue(detail({ revision: 4, content: "# Repairs\nsooner" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Note content" }), { key: "s", ctrlKey: true });
    expect(await screen.findByTitle("Revision 4")).toBeInTheDocument();
    expect(localStorage.getItem("atlas:note-draft:n1")).toBeNull();
  });

  it("a 409 keeps the text, shows the conflict choices and overwrites nothing", async () => {
    await openAndType("# Repairs\nmine");
    vi.mocked(notesApi.update).mockRejectedValue(new ApiError(409, "stale", { detail: { current_revision: 5 } }));
    vi.mocked(notesApi.get).mockResolvedValue(detail({ revision: 5, content: "# Repairs\ntheirs" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Note content" }), { key: "s", ctrlKey: true });
    expect(await screen.findByText(/The server has revision 5\. Nothing was overwritten\./)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note content" })).toHaveValue("# Repairs\nmine");
    expect(screen.getByText("Conflict")).toBeInTheDocument();

    vi.mocked(notesApi.saveConflictCopy).mockResolvedValue({ ...summary, path: "Home/Repairs (conflict).md" });
    fireEvent.click(screen.getByRole("button", { name: "Keep my version as a copy" }));
    expect(notesApi.saveConflictCopy).toHaveBeenCalledWith("n1", "# Repairs\nmine");
    expect(await screen.findByText(/Kept your version as “Home\/Repairs \(conflict\)\.md”/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note content" })).toHaveValue("# Repairs\ntheirs");
  });

  it("flushes the note before opening another one", async () => {
    vi.mocked(notesApi.list).mockResolvedValue({
      notes: [summary, { ...summary, id: "n2", path: "Home/Other.md", title: "Other" }],
      folders: ["Home"],
    });
    await openAndType("# Repairs\nunsaved");
    vi.mocked(notesApi.update).mockResolvedValue(detail({ revision: 4, content: "# Repairs\nunsaved" }));
    vi.mocked(notesApi.get).mockResolvedValue(detail({ id: "n2", path: "Home/Other.md", content: "# Other\n" }));
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    await waitFor(() => expect(notesApi.update).toHaveBeenCalledWith("n1", "# Repairs\nunsaved", 3, expect.anything()));
    expect(await screen.findByTitle("Revision 3")).toHaveTextContent("Home/Other.md");
  });

  it("renames from the header menu after saving, without a prompt", async () => {
    await openAndType("# Repairs\nbefore rename");
    vi.mocked(notesApi.update).mockResolvedValue(detail({ revision: 4, content: "# Repairs\nbefore rename" }));
    vi.mocked(notesApi.move).mockResolvedValue(detail({ revision: 5, path: "Home/Fixes.md" }));
    const prompt = vi.spyOn(window, "prompt");
    await choose("Note options", "Rename");
    const input = screen.getByRole("textbox", { name: "Note name" });
    fireEvent.change(input, { target: { value: "Fixes" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByTitle("Revision 5")).toHaveTextContent("Home/Fixes.md");
    expect(notesApi.update).toHaveBeenCalledBefore(vi.mocked(notesApi.move));
    expect(notesApi.move).toHaveBeenCalledWith("n1", "Home/Fixes.md");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("creates a note from the inline name box", async () => {
    vi.mocked(notesApi.create).mockResolvedValue(detail({ id: "n9", path: "Home/Idea.md", content: "# Idea\n" }));
    render(
      <MemoryRouter initialEntries={["/notes"]}>
        <Notes />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "New note" }));
    const input = screen.getByRole("textbox", { name: "New note name" });
    fireEvent.change(input, { target: { value: "Idea" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByTitle("Revision 3")).toHaveTextContent("Home/Idea.md");
    expect(notesApi.create).toHaveBeenCalledWith("Idea", "# Idea\n");
  });

  it("toggles the details panel with Ctrl+Alt+B", async () => {
    vi.mocked(notesApi.get).mockResolvedValue(detail());
    await openNote();
    const panel = screen.getByRole("region", { name: "Note details" });
    expect(panel).toBeVisible();
    act(() => {
      fireEvent.keyDown(window, { key: "b", code: "KeyB", ctrlKey: true, altKey: true });
    });
    expect(panel).not.toBeVisible();
    expect(localStorage.getItem("atlas-notes-panel")).toBe("closed");
  });

  it("puts back text typed before a reload", async () => {
    localStorage.setItem(
      "atlas:note-draft:n1",
      JSON.stringify({ content: "# Repairs\nfrom before", baseRevision: 3, savedAt: 1 }),
    );
    vi.mocked(notesApi.get).mockResolvedValue(detail());
    vi.mocked(notesApi.update).mockResolvedValue(detail({ revision: 4, content: "# Repairs\nfrom before" }));
    render(
      <MemoryRouter initialEntries={["/notes?open=n1"]}>
        <Notes />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Restored text you typed here/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note content" })).toHaveValue("# Repairs\nfrom before");
    expect(await screen.findByTitle("Revision 4")).toBeInTheDocument();
  });
});
