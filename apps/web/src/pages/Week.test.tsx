import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { projectsApi, tasksApi } from "../api/client";
import {
  addDays,
  dayLabelOf,
  startOfWeek,
  weekLabelOf,
  weekWindow,
} from "../lib/planning";
import { makeProject, makeTask } from "../test/tasks";
import { Week } from "./Week";

vi.mock("../api/client", () => ({
  tasksApi: { list: vi.fn(), create: vi.fn(), complete: vi.fn() },
  projectsApi: { list: vi.fn() },
}));

const listMock = vi.mocked(tasksApi.list);
const projectsMock = vi.mocked(projectsApi.list);

const weekStart = startOfWeek(new Date());
const nextWeekStart = addDays(weekStart, 7);
const tuesday = addDays(weekStart, 1);
const friday = addDays(weekStart, 4);

/** An instant at 09:00 local on the given local day. */
function atNine(date: Date): string {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString();
}

function nameLike(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

beforeEach(() => {
  vi.resetAllMocks();
  projectsMock.mockResolvedValue({ projects: [] });
});

describe("Week", () => {
  it("renders the week as seven local days and places tasks on theirs", async () => {
    listMock.mockResolvedValue({
      tasks: [
        makeTask({ id: "f", title: "Team retro", due_state: "upcoming", due_at: atNine(friday) }),
        makeTask({ id: "t", title: "Dentist", due_state: "upcoming", due_at: atNine(tuesday) }),
      ],
    });

    render(<Week />);

    expect(await screen.findByText("Dentist")).toBeInTheDocument();
    const window = weekWindow(weekStart);
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dueFrom: window.dueFrom,
        dueTo: window.dueTo,
        status: ["inbox", "next", "in_progress"],
      }),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      `Week of ${weekLabelOf(weekStart)}`,
    );

    // Exactly one section per day of the week, Monday first, in a stable order.
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings).toHaveLength(7);
    expect(headings[0]).toHaveTextContent(dayLabelOf(weekStart));

    // Each task appears once, inside its own day's section.
    expect(screen.getAllByText("Dentist")).toHaveLength(1);
    const tuesdaySection = screen
      .getByRole("heading", { level: 2, name: nameLike(dayLabelOf(tuesday)) })
      .closest("section") as HTMLElement;
    const fridaySection = screen
      .getByRole("heading", { level: 2, name: nameLike(dayLabelOf(friday)) })
      .closest("section") as HTMLElement;
    expect(within(tuesdaySection).getByText("Dentist")).toBeInTheDocument();
    expect(within(fridaySection).getByText("Team retro")).toBeInTheDocument();
    expect(within(tuesdaySection).queryByText("Team retro")).toBeNull();
    // The days with no work still render, with a hint.
    expect(within(headings[0].closest("section") as HTMLElement).getByText(/Nothing scheduled/i)).toBeInTheDocument();
  });

  it("offers week navigation as one segmented control, with 'This week' as the current state", async () => {
    listMock.mockResolvedValue({ tasks: [] });
    render(<Week />);
    await screen.findByText(/Nothing planned for this week/i);
    const nav = screen.getByRole("navigation", { name: "Change week" });
    expect(nav).toHaveClass("segmented");
    expect(within(nav).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Previous week",
      "This week",
      "Next week",
    ]);
    expect(within(nav).getByRole("button", { name: "This week" })).toBeDisabled();
    fireEvent.click(within(nav).getByRole("button", { name: "Next week" }));
    expect(within(nav).getByRole("button", { name: "This week" })).toBeEnabled();
  });

  it("highlights today, counts each day and renders an empty day as one muted line", async () => {
    const today = new Date();
    listMock.mockResolvedValue({
      tasks: [makeTask({ id: "a", title: "Today job", due_state: "upcoming", due_at: new Date().toISOString() })],
    });
    render(<Week />);
    expect(await screen.findByText("Today job")).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings).toHaveLength(7);
    const todayCard = screen
      .getAllByRole("heading", { level: 2 })
      .find((heading) => heading.textContent?.startsWith("Today"))
      ?.closest("section") as HTMLElement;
    expect(todayCard).toHaveClass("is-today");
    expect(todayCard).not.toHaveClass("is-empty");
    // The count is decoration (aria-hidden): the heading's name is the day.
    expect(within(todayCard).getByRole("heading", { level: 2 })).toHaveAccessibleName(/^Today · /);
    const empty = document.querySelectorAll(".week-day.is-empty");
    expect(empty.length).toBe(6);
    expect(within(empty[0] as HTMLElement).getByText("Nothing scheduled.")).toBeInTheDocument();
    expect(today).toBeTruthy();
  });

  it("navigates to another week and back", async () => {
    listMock.mockResolvedValue({ tasks: [] });

    render(<Week />);
    await screen.findByText(/Nothing planned for this week/i);

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));

    const window = weekWindow(nextWeekStart);
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ dueFrom: window.dueFrom, dueTo: window.dueTo }),
      ),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      `Week of ${weekLabelOf(nextWeekStart)}`,
    );

    fireEvent.click(screen.getByRole("button", { name: "This week" }));
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ dueFrom: weekWindow(weekStart).dueFrom }),
      ),
    );
  });

  it("shows the project context and derived progress for the week", async () => {
    listMock.mockResolvedValue({
      tasks: [makeTask({ id: "t", title: "Dentist", due_state: "upcoming", due_at: atNine(tuesday), project_id: "p1" })],
    });
    projectsMock.mockResolvedValue({
      projects: [
        makeProject({ id: "p1", name: "Atlas launch", progress: { total: 4, completed: 1, percent: 25 } }),
      ],
    });

    render(<Week />);

    expect(await screen.findByText("Dentist")).toBeInTheDocument();
    expect(screen.getAllByText("Atlas launch")).toHaveLength(2);
    expect(screen.getByText("1/4 · 25%")).toBeInTheDocument();
  });

  it("keeps the week visible when project context fails to load", async () => {
    listMock.mockResolvedValue({
      tasks: [makeTask({ id: "t", title: "Dentist", due_state: "upcoming", due_at: atNine(tuesday) })],
    });
    projectsMock.mockRejectedValue(new Error("projects unavailable"));

    render(<Week />);

    expect(await screen.findByText("Dentist")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Project names are unavailable/i);
  });

  it("shows a useful empty state for a week with nothing planned", async () => {
    listMock.mockResolvedValue({ tasks: [] });

    render(<Week />);

    expect(await screen.findByText(/Nothing planned for this week/i)).toBeInTheDocument();
  });

  it("shows a clear error and can retry", async () => {
    listMock.mockRejectedValueOnce(new Error("Server unreachable"));

    render(<Week />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Server unreachable");

    listMock.mockResolvedValueOnce({
      tasks: [makeTask({ id: "t", title: "Recovered", due_state: "upcoming", due_at: atNine(tuesday) })],
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Recovered")).toBeInTheDocument();
  });
});
