import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { calendarApi } from "../api/client";
import { makeAccount, makeSource } from "../test/calendar";
import { CalendarSettings } from "./CalendarSettings";

vi.mock("../api/client", async (original) => ({
  ...(await original<typeof import("../api/client")>()),
  calendarApi: {
    accounts: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), syncProvider: vi.fn(),
    updateSource: vi.fn(), previewFeed: vi.fn(), addFeed: vi.fn(), removeFeed: vi.fn(),
    previewImport: vi.fn(), addImport: vi.fn(), replaceImport: vi.fn(),
  },
}));

const api = vi.mocked(calendarApi);
const ics = (extra = {}) => makeAccount({ provider: "ics", label: "Calendar feed (ICS)", redirect_uri: null, ...extra });

function show(path = "/settings/calendar") {
  return render(<MemoryRouter initialEntries={[path]}><CalendarSettings /></MemoryRouter>);
}

beforeEach(() => vi.resetAllMocks());

describe("CalendarSettings", () => {
  it("shows setup help, not a broken button, for a provider the server has not configured", async () => {
    api.accounts.mockResolvedValue({
      providers: [makeAccount({ configured: false, setup_problems: ["client_id_missing", "public_base_url_not_https"] }), ics()],
    });
    show();
    const card = (await screen.findByRole("heading", { name: "Google Calendar" })).closest("li")!;
    expect(within(card).getByText("Not configured")).toBeInTheDocument();
    expect(within(card).getByText(/client ID is not set/)).toBeInTheDocument();
    expect(within(card).getByText("https://atlas.example.test/api/calendar/google/callback")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /Connect/ })).toBeNull();
  });

  it("starts the OAuth redirect from the Connect button", async () => {
    api.accounts.mockResolvedValue({ providers: [makeAccount(), ics()] });
    api.connect.mockResolvedValue({ authorization_url: "https://accounts.example.test/auth?state=x" });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Connect Google Calendar" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://accounts.example.test/auth?state=x"));
    vi.unstubAllGlobals();
  });

  it("lists calendars with a visibility toggle, a colour and badges, and saves changes", async () => {
    api.accounts.mockResolvedValue({
      providers: [
        makeAccount({
          connected: true,
          calendars: [makeSource(), makeSource({ id: "src-2", name: "Holidays", is_primary: false, is_read_only: true, selected: false, color: "3" })],
        }),
        ics(),
      ],
    });
    api.updateSource.mockResolvedValue(makeSource());
    show();
    const holidays = await screen.findByRole("checkbox", { name: /Holidays/ });
    expect(holidays).not.toBeChecked();
    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(screen.getByText("Primary")).toBeInTheDocument();
    fireEvent.click(holidays);
    await waitFor(() => expect(api.updateSource).toHaveBeenCalledWith("src-2", { selected: true }));
    fireEvent.click(screen.getByRole("button", { name: "Colour of Holidays: Green" }));
    fireEvent.click(screen.getByRole("radio", { name: "Purple" }));
    await waitFor(() => expect(api.updateSource).toHaveBeenCalledWith("src-2", { color: "7" }));
  });

  it("asks before disconnecting and says what happens to the events", async () => {
    api.accounts.mockResolvedValue({ providers: [makeAccount({ connected: true, calendars: [makeSource()] }), ics()] });
    api.disconnect.mockResolvedValue({ revoked_at_provider: true, calendars_removed: 1, events_removed: 12 });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(screen.getByText(/deletes the saved sign-in/)).toBeInTheDocument();
    expect(api.disconnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect and delete stored events" }));
    await waitFor(() => expect(api.disconnect).toHaveBeenCalledWith("google"));
    expect(await screen.findByText(/12 stored events were removed/)).toBeInTheDocument();
  });

  it("asks to reconnect when the provider rejected the saved sign-in", async () => {
    api.accounts.mockResolvedValue({ providers: [makeAccount({ connected: true, needs_reauth: true, calendars: [makeSource()] }), ics()] });
    show();
    expect(await screen.findByText("Needs re-authorisation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/stopped accepting/);
  });

  it("shows the last sync error of a calendar", async () => {
    api.accounts.mockResolvedValue({
      providers: [makeAccount(), ics({ connected: true, calendars: [makeSource({ provider: "ics", id: "f1", name: "Proton", state: "error", last_error: "feed unreachable: timed out", feed_url_display: "https://calendar.proton.me/••••••••" })] })],
    });
    show();
    expect(await screen.findByText("feed unreachable: timed out")).toBeInTheDocument();
    expect(screen.getByLabelText("Feed link, masked")).toHaveTextContent("https://calendar.proton.me/");
  });

  it("tests and adds a feed with a masked link field, then clears it", async () => {
    api.accounts.mockResolvedValue({ providers: [makeAccount(), ics()] });
    api.previewFeed.mockResolvedValue({ event_count: 4, name: null, skipped: 0 });
    api.addFeed.mockResolvedValue(makeSource({ provider: "ics" }));
    show();
    const link = await screen.findByLabelText("Feed link (secret)");
    expect(link).toHaveAttribute("type", "password");
    fireEvent.change(link, { target: { value: "https://calendar.proton.me/secret.ics" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Proton" } });
    fireEvent.click(screen.getByRole("button", { name: "Test feed" }));
    expect(await screen.findByText(/with 4 events/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add feed" }));
    await waitFor(() => expect(api.addFeed).toHaveBeenCalledWith({ url: "https://calendar.proton.me/secret.ics", name: "Proton", color: undefined }));
    await waitFor(() => expect(screen.getByLabelText("Feed link (secret)")).toHaveValue(""));
  });

  it("confirms before removing a feed", async () => {
    api.accounts.mockResolvedValue({ providers: [makeAccount(), ics({ connected: true, calendars: [makeSource({ provider: "ics", id: "f1", name: "Proton" })] })] });
    api.removeFeed.mockResolvedValue(undefined);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Remove feed Proton" }));
    expect(api.removeFeed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove feed" }));
    await waitFor(() => expect(api.removeFeed).toHaveBeenCalledWith("f1"));
  });

  it("reports the outcome of the OAuth callback once and removes it from the address", async () => {
    api.accounts.mockResolvedValue({ providers: [makeAccount({ connected: true, calendars: [makeSource()] }), ics()] });
    show("/settings/calendar?calendar_provider=google&calendar_result=insufficient_scope");
    expect(await screen.findByText(/not given permission to read your calendars/)).toBeInTheDocument();
  });

  it("shows a clear load error and can retry", async () => {
    api.accounts.mockRejectedValueOnce(new Error("Server unreachable"));
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("Server unreachable");
    api.accounts.mockResolvedValueOnce({ providers: [makeAccount(), ics()] });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Google Calendar" })).toBeInTheDocument();
  });
});

describe("importing an .ics file (M5-12)", () => {
  const file = (text: string, name = "family.ics") => new File([text], name, { type: "text/calendar" });
  const ICS = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";

  it("reads the chosen file, checks it on the server, then imports it with the name from the file", async () => {
    api.accounts.mockResolvedValue({ providers: [ics()] });
    api.previewImport.mockResolvedValue({ event_count: 3, name: null, skipped: 1 });
    api.addImport.mockResolvedValue(makeSource({ provider: "ics", is_import: true, name: "family" }));
    show();
    const input = await screen.findByLabelText("Calendar file");
    fireEvent.change(input, { target: { files: [file(ICS)] } });
    await waitFor(() => expect(screen.getByLabelText("Calendar name")).toHaveValue("family"));
    fireEvent.click(screen.getByRole("button", { name: "Check file" }));
    expect(await screen.findByText(/Readable calendar with 3 events \(1 could not be read\)/)).toBeInTheDocument();
    expect(api.previewImport).toHaveBeenCalledWith(ICS);
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(api.addImport).toHaveBeenCalledWith({ content: ICS, name: "family", color: undefined }));
  });

  it("refuses a file over 5 MiB before uploading it", async () => {
    api.accounts.mockResolvedValue({ providers: [ics()] });
    show();
    const big = new File(["x"], "huge.ics");
    Object.defineProperty(big, "size", { value: 6 * 1024 * 1024 });
    fireEvent.change(await screen.findByLabelText("Calendar file"), { target: { files: [big] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("larger than 5 MiB");
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    expect(api.previewImport).not.toHaveBeenCalled();
  });

  it("offers Replace file only on imported calendars and sends the new text", async () => {
    api.accounts.mockResolvedValue({
      providers: [ics({ calendars: [makeSource({ id: "imp", provider: "ics", name: "Family", is_import: true, feed_url_display: "Imported file" }), makeSource({ id: "feed", provider: "ics", name: "Proton", feed_url_display: "https://x/••" })] })],
    });
    api.replaceImport.mockResolvedValue(makeSource({ id: "imp", provider: "ics", is_import: true }));
    show();
    const replace = await screen.findByLabelText("Replace the file of Family");
    expect(screen.queryByLabelText("Replace the file of Proton")).toBeNull();
    fireEvent.change(replace, { target: { files: [file(ICS, "new.ics")] } });
    await waitFor(() => expect(api.replaceImport).toHaveBeenCalledWith("imp", ICS));
  });
});

