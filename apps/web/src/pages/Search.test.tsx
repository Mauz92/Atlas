import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { ApiError, searchApi, tasksApi } from "../api/client";
import { makeTask } from "../test/tasks";
import { SearchPage } from "./Search";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ApiError: actual.ApiError,
    searchApi: { search: vi.fn() },
    tasksApi: { get: vi.fn() },
  };
});

// The detail panel has its own tests; here only that it is opened on the found task matters.
vi.mock("../components/TaskDetail", () => ({
  TaskDetail: ({ task }: { task: { title: string } }) => (
    <div role="dialog" aria-label="Task details">
      {task.title}
    </div>
  ),
}));

function setup(url = "/search") {
  render(
    <MemoryRouter initialEntries={[url]}>
      <SearchPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("SearchPage", () => {
  it("searches the URL text and lists notes, tasks and projects as links and buttons", async () => {
    vi.mocked(searchApi.search).mockResolvedValue({
      query: "zeb",
      notes: [{ id: "n1", path: "a/Zebra.md", title: "Zebra" }],
      tasks: [
        { id: "t1", title: "Feed zebra", status: "next", priority: "none", due_at: null, project_id: null },
      ],
      projects: [{ id: "p1", name: "Zebra crossing", status: "active" }],
    });
    vi.mocked(tasksApi.get).mockResolvedValue(makeTask({ id: "t1", title: "Feed zebra" }));
    setup("/search?q=zeb");

    expect(await screen.findByRole("link", { name: "Zebra" })).toHaveAttribute("href", "/notes?open=n1");
    expect(screen.getByRole("link", { name: "Zebra crossing" })).toHaveAttribute("href", "/projects/p1");
    expect(screen.getByRole("status")).toHaveTextContent("3 results");
    expect(searchApi.search).toHaveBeenCalledWith("zeb", expect.objectContaining({ limit: 25 }));

    // A result is the shared task row (UX-03): read-only, with its status in the meta line.
    expect(screen.getByText("Next")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Feed zebra" }));
    expect(await screen.findByRole("dialog", { name: "Task details" })).toBeInTheDocument();
  });

  it("explains an empty result and shows a server error verbatim", async () => {
    vi.mocked(searchApi.search).mockResolvedValueOnce({ query: "x", notes: [], tasks: [], projects: [] });
    setup("/search?q=nothing");
    expect(await screen.findByText("Nothing matches “nothing”.")).toBeInTheDocument();

    vi.mocked(searchApi.search).mockRejectedValue(new ApiError(422, "q: too long"));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "other" } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("q: too long"));
  });
});
