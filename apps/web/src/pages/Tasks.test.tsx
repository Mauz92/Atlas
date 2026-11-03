import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import { tasksApi } from "../api/client";
import { ProjectsProvider } from "../hooks/useProjects";
import { choose } from "../test/menu";
import { makeProject, makeTask } from "../test/tasks";
import { Tasks } from "./Tasks";

vi.mock("../api/client", () => ({
  tasksApi: {
    list: vi.fn(),
    complete: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    restore: vi.fn(),
  },
  projectsApi: { list: vi.fn().mockResolvedValue({ projects: [] }) },
}));
vi.mock("../hooks/useProjects", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useProjects")>("../hooks/useProjects");
  return { ...actual, useProjects: () => ({ projects: [makeProject({ id: "p1", name: "Home" })], state: "ready", error: null, reload: async () => {} }) };
});

const list = vi.mocked(tasksApi.list);
const one = makeTask({ id: "t1", title: "Alpha", status: "next", priority: "high" });
const two = makeTask({ id: "t2", title: "Beta", status: "inbox" });

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.search}</p>;
}

function renderPage(url = "/tasks") {
  render(
    <MemoryRouter initialEntries={[url]}>
      <ProjectsProvider>
        <Tasks />
        <Where />
      </ProjectsProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  list.mockResolvedValue({ tasks: [one, two] });
});

describe("Tasks page", () => {
  it("reads the filter from the URL, queries the server with it, and writes changes back", async () => {
    renderPage("/tasks?priority=high&due_from=2026-11-01");
    await screen.findByText("Alpha");
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({
        priority: "high",
        status: ["inbox", "next", "in_progress"],
        dueFrom: new Date("2026-11-01T00:00:00").toISOString(),
      }),
    );
    await choose("Status: Open", "Completed");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("status=completed"));
    expect(screen.getByTestId("where")).toHaveTextContent("priority=high");
  });

  it("shows a skeleton while loading, then tells 'none yet' from 'no results'", async () => {
    list.mockResolvedValue({ tasks: [] });
    renderPage("/tasks");
    expect(screen.getByRole("status")).toHaveTextContent("Loading tasks…");
    // None yet: points at the Inbox.
    expect(await screen.findByText(/No open tasks/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to Inbox" })).toBeInTheDocument();
  });

  it("says no tasks match when a filter is set, with no second action", async () => {
    list.mockResolvedValue({ tasks: [] });
    renderPage("/tasks?priority=high");
    expect(await screen.findByText("No tasks match these filters.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go to Inbox" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reset filters" })).toBeInTheDocument();
  });

  it("shows a server validation error verbatim", async () => {
    list.mockRejectedValue(new Error("due: from must not be after to"));
    renderPage("/tasks?due_from=2026-12-01&due_to=2026-11-01");
    expect(await screen.findByRole("alert")).toHaveTextContent("due: from must not be after to");
  });

  it("selects with the keyboard-reachable checkboxes and bulk completes, reporting failures per task", async () => {
    vi.mocked(tasksApi.complete)
      .mockResolvedValueOnce(one)
      .mockRejectedValueOnce(new Error("invalid status transition"));
    renderPage();
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByLabelText("Select all"));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Complete selected" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Beta: invalid status transition");
    // The one that succeeded left the selection; the failed one stays selected for a retry.
    await waitFor(() => expect(screen.getByText("1 selected")).toBeInTheDocument());
  });

  it("moves the selection to a project, and to no project", async () => {
    vi.mocked(tasksApi.update).mockResolvedValue(one);
    renderPage();
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByLabelText("Select Alpha"));
    await choose("Move to project…", "Home");
    await waitFor(() => expect(tasksApi.update).toHaveBeenCalledWith(one, { project_id: "p1" }));
  });

  it("deletes the selection and undoes it through the restore endpoint", async () => {
    vi.mocked(tasksApi.remove).mockResolvedValue(undefined);
    vi.mocked(tasksApi.restore).mockResolvedValue(one);
    renderPage();
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByLabelText("Select all"));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    const toast = await screen.findByRole("status");
    expect(toast).toHaveTextContent("Deleted 2 tasks.");
    fireEvent.click(within(toast).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(tasksApi.restore).toHaveBeenCalledTimes(2));
    expect(tasksApi.restore).toHaveBeenCalledWith("t1");
  });

  it("saves the current view from the bar's menu, applies it later, and removes it", async () => {
    renderPage("/tasks?priority=high");
    await screen.findByText("Alpha");
    await choose("Filter options", "Save this view…");
    fireEvent.change(screen.getByLabelText("Saved filter name"), { target: { value: "Urgent stuff" } });
    fireEvent.click(screen.getByRole("button", { name: "Save this view" }));
    expect(screen.queryByLabelText("Saved filter name")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("atlas.savedTaskFilters")).toContain("Urgent stuff");
    expect(window.localStorage.getItem("atlas.savedTaskFilters")).toContain("priority=high");

    // Apply it from another view.
    await choose("Priority: High", "Any priority");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^$/));
    await choose("Filter options", "Saved views", "Urgent stuff");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("priority=high"));

    await choose("Filter options", "Remove a saved view", "Urgent stuff");
    expect(window.localStorage.getItem("atlas.savedTaskFilters")).not.toContain("Urgent stuff");
    fireEvent.click(await screen.findByRole("button", { name: "Filter options" }));
    expect(screen.queryByRole("menuitem", { name: "Saved views" })).not.toBeInTheDocument();
  });

  it("shows a set chip with its value, and the Due popover sets presets and a custom range", async () => {
    renderPage("/tasks?priority=urgent&sort=title");
    await screen.findByText("Alpha");
    expect(screen.getByRole("button", { name: "Priority: Urgent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sort: Title" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Due" }));
    const dialog = screen.getByRole("dialog", { name: "Due date" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Next 7 days" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("due_from="));
    expect(screen.getByTestId("where")).toHaveTextContent("due_to=");
    expect(screen.getByRole("button", { name: "Due: Next 7 days" })).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("Due to"), { target: { value: "2031-01-05" } });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("due_to=2031-01-05"));
    // Esc closes the popover and returns focus to the chip.
    fireEvent.keyDown(within(dialog).getByLabelText("Due to"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Due date" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Due:/ })).toHaveFocus();
  });

  it("switches between List and Board, keeping the filter in the URL", async () => {
    renderPage("/tasks?priority=high");
    await screen.findByText("Alpha");
    expect(screen.queryByRole("heading", { name: "In progress" })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "View" })).getByRole("button", { name: "Board" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("view=board"));
    expect(screen.getByTestId("where")).toHaveTextContent("priority=high");
    expect(screen.getByRole("heading", { name: "In progress" })).toBeInTheDocument();
    // Archived is behind a toggle.
    expect(screen.queryByRole("heading", { name: "Archived" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Show archived/ }));
    expect(screen.getByRole("heading", { name: "Archived" })).toBeInTheDocument();
    // The list query did not run again just for the view.
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("floats the bulk bar while rows are selected and clears the selection", async () => {
    renderPage();
    await screen.findByText("Alpha");
    expect(screen.queryByRole("toolbar", { name: "Bulk actions" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select Alpha"));
    expect(screen.getByRole("toolbar", { name: "Bulk actions" })).toHaveTextContent("1 selected");
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("toolbar", { name: "Bulk actions" })).not.toBeInTheDocument();
  });
});

describe("reset", () => {
  it("clears every filter, including the pending search text", async () => {
    renderPage("/tasks?priority=high&q=al");
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^$/));
    expect(screen.getByLabelText("Search")).toHaveValue("");
    await choose("Priority", "Urgent");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("priority=urgent"));
    expect(screen.getByTestId("where")).not.toHaveTextContent("q=");
  });
});
