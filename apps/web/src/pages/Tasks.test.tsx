import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import { tasksApi } from "../api/client";
import { ProjectsProvider } from "../hooks/useProjects";
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
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "completed" } });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("status=completed"));
    expect(screen.getByTestId("where")).toHaveTextContent("priority=high");
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
    fireEvent.change(screen.getByLabelText("Move selected to project"), { target: { value: "p1" } });
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

  it("saves the current view as a shortcut, persists it, and removes it", async () => {
    renderPage("/tasks?priority=high");
    await screen.findByText("Alpha");
    fireEvent.change(screen.getByLabelText("Saved filter name"), { target: { value: "Urgent stuff" } });
    fireEvent.click(screen.getByRole("button", { name: "Save this view" }));
    const link = await screen.findByRole("link", { name: "Urgent stuff" });
    expect(link).toHaveAttribute("href", "/tasks?priority=high");
    expect(window.localStorage.getItem("atlas.savedTaskFilters")).toContain("Urgent stuff");
    fireEvent.click(screen.getByRole("button", { name: "Remove saved filter Urgent stuff" }));
    expect(screen.queryByRole("link", { name: "Urgent stuff" })).not.toBeInTheDocument();
  });
});

describe("reset", () => {
  it("clears every filter, including the pending search text", async () => {
    renderPage("/tasks?priority=high&q=al");
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^$/));
    expect(screen.getByLabelText("Search")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "urgent" } });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("priority=urgent"));
    expect(screen.getByTestId("where")).not.toHaveTextContent("q=");
  });
});
