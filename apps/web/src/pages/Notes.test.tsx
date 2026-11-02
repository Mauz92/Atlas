import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { notesApi, projectsApi, tasksApi, type NoteDetail } from "../api/client";
import { localDate } from "../lib/taskForm";
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
    fireEvent.click(
      await screen.findByRole("button", { name: "Today's note" }),
    );
    expect(
      await screen.findByText(
        new RegExp(`daily/${localDate()}.md · revision 3`),
      ),
    ).toBeInTheDocument();
    expect(notesApi.openDaily).toHaveBeenCalledWith(localDate());
  });

  it("offers only templates/ notes, creates from one, and shows server errors verbatim", async () => {
    vi.mocked(notesApi.list).mockResolvedValue({
      notes: [summary, template],
      folders: [],
    });
    vi.mocked(notesApi.createFromTemplate)
      .mockRejectedValueOnce(new Error("A note or folder already exists there"))
      .mockResolvedValueOnce(
        detail({ id: "new", path: "Work/Standup.md", content: "# Standup\n" }),
      );
    renderNotes("/notes?new=template");

    const picker = await screen.findByRole("combobox", { name: "Template" });
    await waitFor(() => expect(picker).toHaveFocus());
    expect(
      within(picker)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Choose a template", "Meeting"]);
    const create = screen.getByRole("button", { name: "New from template" });
    expect(create).toBeDisabled();
    fireEvent.change(picker, { target: { value: "tpl" } });
    fireEvent.change(screen.getByLabelText("New note or folder path"), {
      target: { value: "Work/Standup" },
    });
    fireEvent.click(create);
    expect(
      await screen.findByText("A note or folder already exists there"),
    ).toBeInTheDocument();
    fireEvent.click(create);
    expect(
      await screen.findByText(/Work\/Standup.md · revision 3/),
    ).toBeInTheDocument();
    expect(notesApi.createFromTemplate).toHaveBeenLastCalledWith(
      "Work/Standup",
      "tpl",
      localDate(),
    );
  });

  it("explains when there are no templates", async () => {
    renderNotes();
    expect(
      await screen.findByRole("combobox", { name: "Template" }),
    ).toBeDisabled();
    expect(screen.getByText(/No templates/)).toBeInTheDocument();
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
