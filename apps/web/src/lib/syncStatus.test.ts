import { makeProviderSyncStatus } from "../test/calendar";
import {
  cursorHealthLabel,
  formatLastSync,
  lastSyncText,
  providerLabel,
  stateLabel,
} from "./syncStatus";

describe("providerLabel", () => {
  it("maps the known providers to friendly names", () => {
    expect(providerLabel("google")).toBe("Google Calendar");
    expect(providerLabel("microsoft")).toBe("Microsoft Outlook");
  });

  it("falls back to the raw value for an unknown provider", () => {
    expect(providerLabel("caldav")).toBe("caldav");
  });
});

describe("stateLabel", () => {
  it("labels each derived state", () => {
    expect(stateLabel("idle")).toBe("Up to date");
    expect(stateLabel("error")).toBe("Sync failed");
    expect(stateLabel("never_synced")).toBe("Not synced yet");
  });

  it("passes through an unknown state rather than inventing one", () => {
    expect(stateLabel("mystery")).toBe("mystery");
  });
});

describe("cursorHealthLabel", () => {
  it("labels each cursor health", () => {
    expect(cursorHealthLabel("ok")).toBe("Cursor healthy");
    expect(cursorHealthLabel("missing")).toBe("No cursor yet");
    expect(cursorHealthLabel("error")).toBe("Cursor stopped");
  });
});

describe("formatLastSync", () => {
  it("returns null when there is no instant", () => {
    expect(formatLastSync(null)).toBeNull();
  });

  it("returns null for an unparseable value", () => {
    expect(formatLastSync("not-a-date")).toBeNull();
  });

  it("formats a valid instant into a readable, local string", () => {
    const formatted = formatLastSync("2026-10-27T09:00:00+00:00");
    expect(formatted).not.toBeNull();
    expect(formatted).toContain("2026");
  });
});

describe("lastSyncText", () => {
  it("describes a provider that has synced", () => {
    const text = lastSyncText(makeProviderSyncStatus());
    expect(text).not.toBeNull();
    expect(text?.startsWith("Last synced ")).toBe(true);
  });

  it("returns null for a provider that has never synced", () => {
    expect(
      lastSyncText(makeProviderSyncStatus({ state: "never_synced", last_success_at: null })),
    ).toBeNull();
  });
});
