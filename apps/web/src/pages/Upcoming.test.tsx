import { render, screen } from "@testing-library/react";

import { tasksApi } from "../api/client";
import { makeTask } from "../test/tasks";
import { Upcoming } from "./Upcoming";

vi.mock("../api/client", () => ({
  tasksApi: { list: vi.fn(), create: vi.fn(), complete: vi.fn() },
}));

const listMock = vi.mocked(tasksApi.list);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Upcoming", () => {
  it("renders upcoming tasks grouped by the day they are due", async () => {
    listMock.mockResolvedValue({
      tasks: [
        makeTask({
          id: "b",
          title: "Team retro",
          due_state: "upcoming",
          due_at: "2026-10-28T09:00:00+00:00",
        }),
        makeTask({
          id: "a",
          title: "Dentist",
          due_state: "upcoming",
          due_at: "2026-10-27T09:00:00+00:00",
        }),
      ],
    });

    render(<Upcoming />);

    expect(await screen.findByText("Dentist")).toBeInTheDocument();
    expect(screen.getByText("Team retro")).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ view: "upcoming" }));
    // One heading per calendar day (in the viewer's/UTC zone), soonest first.
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
  });

  it("shows a useful empty state", async () => {
    listMock.mockResolvedValue({ tasks: [] });

    render(<Upcoming />);

    expect(await screen.findByText(/Nothing is scheduled/i)).toBeInTheDocument();
  });

  it("shows a clear error when loading fails", async () => {
    listMock.mockRejectedValueOnce(new Error("Request timed out"));

    render(<Upcoming />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Request timed out");
  });
});
