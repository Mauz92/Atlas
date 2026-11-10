import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { calendarApi, type CalendarEvent } from "../api/client";
import { dayKeyIn } from "../lib/calendar";
import { makeAccount, makeSource } from "../test/calendar";
import { CalendarPage } from "./Calendar";

vi.mock("../api/client", async (original) => ({
  ...(await original<typeof import("../api/client")>()),
  calendarApi: { accounts: vi.fn(), events: vi.fn(), eventDetail: vi.fn() },
}));

const api = vi.mocked(calendarApi);
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const today = dayKeyIn(new Date(), zone);

function at(hour: number, minutes = 0): string {
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour, minutes)).toISOString();
}

function event(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "e1", occurrence: null, source_id: "src-1", provider: "ics", title: "Standup",
    start: at(12), end: at(13), time_zone: "UTC", is_all_day: false, start_date: null, end_date: null,
    status: "confirmed", is_recurring: false, location: null, ...overrides,
  };
}

function page() {
  return render(<MemoryRouter><CalendarPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  api.accounts.mockResolvedValue({ providers: [makeAccount({ connected: true, calendars: [makeSource({ provider: "ics", name: "Proton" })] })] });
});

describe("CalendarPage", () => {
  it("offers to connect a calendar when none exists", async () => {
    api.accounts.mockResolvedValue({ providers: [makeAccount()] });
    api.events.mockResolvedValue({ events: [], total: 0, truncated: false });
    page();
    expect(await screen.findByText(/No calendar is connected yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect a calendar" })).toBeInTheDocument();
  });

  it("shows loading, then events with their calendar name in an accessible label", async () => {
    api.events.mockResolvedValue({ events: [event({})], total: 1, truncated: false });
    page();
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Agenda" }));
    const button = await screen.findByRole("button", { name: /Standup/ });
    expect(button).toBeInTheDocument();
  });

  it("lists multi-day all-day events on each of their days", async () => {
    const start = today;
    const end = new Date(Date.parse(`${today}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10);
    api.events.mockResolvedValue({
      events: [event({ id: "trip", title: "Trip", is_all_day: true, start_date: start, end_date: end })], total: 1, truncated: false,
    });
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Agenda" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^All day Trip/ })).toHaveLength(3));
  });

  it("highlights today and moves with the previous/next/today controls", async () => {
    api.events.mockResolvedValue({ events: [], total: 0, truncated: false });
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Day" }));
    expect(screen.getByRole("button", { name: "Today" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    await waitFor(() => expect(api.events).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("button", { name: "Today" })).toBeEnabled();
    fireEvent.keyDown(document, { key: "t" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Today" })).toBeDisabled());
  });

  it("switches views from the keyboard and remembers the choice", async () => {
    api.events.mockResolvedValue({ events: [], total: 0, truncated: false });
    page();
    await screen.findByRole("group", { name: "View" });
    fireEvent.keyDown(document, { key: "m" });
    expect(screen.getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("atlas-calendar-view")).toBe("month");
    fireEvent.keyDown(document, { key: "ArrowRight" });
    await waitFor(() => expect(api.events.mock.calls.length).toBeGreaterThan(2));
  });

  it("opens a read-only detail with the provider link and the event's own zone", async () => {
    api.events.mockResolvedValue({ events: [event({ time_zone: "Pacific/Auckland", location: "Room 2", is_recurring: true })], total: 1, truncated: false });
    api.eventDetail.mockResolvedValue({
      ...event({ time_zone: "Pacific/Auckland", location: "Room 2", is_recurring: true }),
      description: "<b>Bring slides</b>", web_link: "https://calendar.example.test/e/1", calendar_name: "Proton", is_read_only: true, last_synced_at: at(11),
    });
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Agenda" }));
    fireEvent.click(await screen.findByRole("button", { name: /Standup/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Read only")).toBeInTheDocument();
    expect(within(dialog).getByText("Repeats")).toBeInTheDocument();
    // untrusted text is never interpreted as HTML
    expect(await within(dialog).findByText("<b>Bring slides</b>")).toBeInTheDocument();
    const link = within(dialog).getByRole("link", { name: /Open in/ });
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows a retryable error and an honest empty period", async () => {
    api.events.mockRejectedValueOnce(new Error("Server unreachable"));
    page();
    expect(await screen.findByRole("alert")).toHaveTextContent("Server unreachable");
    api.events.mockResolvedValueOnce({ events: [], total: 0, truncated: false });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Nothing on your calendars in this period/)).toBeInTheDocument();
  });
});
