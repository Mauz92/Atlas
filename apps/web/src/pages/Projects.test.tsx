import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { projectsApi } from "../api/client";
import { ProjectsProvider } from "../hooks/useProjects";
import { choose } from "../test/menu";
import { makeProject } from "../test/tasks";
import { Projects } from "./Projects";

vi.mock("../api/client", () => ({
  projectsApi: { list: vi.fn(), create: vi.fn(), update: vi.fn() },
}));

const listMock = vi.mocked(projectsApi.list);
const createMock = vi.mocked(projectsApi.create);
const updateMock = vi.mocked(projectsApi.update);

const home = makeProject({
  id: "p1",
  name: "Home",
  progress: { total: 4, completed: 1, percent: 25 },
});
const old = makeProject({ id: "p2", name: "Old", status: "archived" });

function renderPage() {
  render(
    <MemoryRouter>
      <ProjectsProvider>
        <Projects />
      </ProjectsProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  listMock.mockResolvedValue({ projects: [home, old] });
});

describe("Projects", () => {
  it("lists live projects with progress, open count and target date; archived ones sit behind a toggle", async () => {
    listMock.mockResolvedValue({
      projects: [{ ...home, target_date: "2031-03-04" }, old],
    });
    renderPage();
    expect(await screen.findByRole("link", { name: "Home" })).toHaveAttribute(
      "href",
      "/projects/p1",
    );
    expect(screen.getByText("1/4 done · 25%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Progress 25%" })).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText("3 open")).toBeInTheDocument();
    // One date format, never the raw ISO date.
    expect(screen.getByText(/^Target .*Mar.*2031/)).toBeInTheDocument();
    expect(screen.queryByText(/2031-03-04/)).not.toBeInTheDocument();
    // Archive is not a visible button on the row.
    expect(screen.queryByRole("button", { name: /^Archive/ })).not.toBeInTheDocument();

    expect(screen.queryByRole("link", { name: "Old" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show archived (1)" }));
    expect(screen.getByRole("heading", { name: "Archived" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Old" })).toBeInTheDocument();
  });

  it("creates a project and reloads the list; a server error is shown verbatim", async () => {
    createMock
      .mockRejectedValueOnce(new Error("name: too long"))
      .mockResolvedValueOnce(makeProject({ name: "Trip" }));
    renderPage();
    await screen.findByRole("link", { name: "Home" });

    fireEvent.click(screen.getByText("New project"));
    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "Trip" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("name: too long");

    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it("archives from the row menu and restores an archived project", async () => {
    updateMock.mockResolvedValue(home);
    renderPage();
    await choose("Actions for Home", "Archive project");
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(home, { status: "archived" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Show archived/ }));
    await choose("Actions for Old", "Restore project");
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(old, { status: "active" }),
    );
  });
});
