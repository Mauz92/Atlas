import { makeProject, makeTask } from "../test/tasks";
import { apiFetch, calendarApi, changesApi, notificationsApi, projectsApi, tasksApi } from "./client";

describe("tasksApi.setStatus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes the task status together with its base_revision", async () => {
    const updated = makeTask({ id: "t1", status: "in_progress", revision: 5 });
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => updated });
    vi.stubGlobal("fetch", fetchMock);

    const task = makeTask({ id: "t1", status: "inbox", revision: 4 });
    const result = await tasksApi.setStatus(task, "in_progress");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/tasks/t1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({
      status: "in_progress",
      base_revision: 4,
    });
    expect(result).toEqual(updated);
  });
});

describe("tasksApi.list", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards the status, project and time-zone filters as query parameters", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ tasks: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    await tasksApi.list({ status: "inbox", projectId: "p1", tz: "Europe/Berlin" });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url.startsWith("/api/tasks?")).toBe(true);
    expect(url).toContain("status=inbox");
    expect(url).toContain("project_id=p1");
    expect(url).toContain("tz=Europe%2FBerlin");
  });

  it("requests the whole listing when no options are given", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ tasks: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    await tasksApi.list();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/tasks");
  });

  it("forwards a planning window and several statuses as query parameters", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ tasks: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    await tasksApi.list({
      dueFrom: "2026-10-26T00:00:00.000Z",
      dueTo: "2026-10-27T00:00:00.000Z",
      status: ["inbox", "next", "in_progress"],
      tz: "Europe/Berlin",
    });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("due_from=2026-10-26T00%3A00%3A00.000Z");
    expect(url).toContain("due_to=2026-10-27T00%3A00%3A00.000Z");
    // The server accepts the repeated or comma-separated form (ADR-0018).
    expect(url).toContain("status=inbox%2Cnext%2Cin_progress");
    expect(url).toContain("tz=Europe%2FBerlin");
  });
});

describe("projectsApi.list", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the caller's projects, which carry their derived progress", async () => {
    const project = makeProject({ id: "p1", name: "Atlas launch" });
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ projects: [project] }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await projectsApi.list();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects");
    expect(result.projects).toEqual([project]);
  });
});

describe("calendarApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the sync status", async () => {
    const status = { providers: [] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => status });
    vi.stubGlobal("fetch", fetchMock);

    const result = await calendarApi.syncStatus();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/calendar/sync-status");
    expect(result).toEqual(status);
  });

  it("POSTs a provider sync to the trigger endpoint", async () => {
    const outcome = { provider: "google", calendars: [] };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => outcome });
    vi.stubGlobal("fetch", fetchMock);

    const result = await calendarApi.syncProvider("google");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/calendar/providers/google/sync");
    expect(init.method).toBe("POST");
    expect(result).toEqual(outcome);
  });
});

describe("changesApi.list", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pulls the change feed from the stored cursor", async () => {
    const feed = { changes: [], since: 12, next_since: 12, has_more: false, resync_required: false };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => feed });
    vi.stubGlobal("fetch", fetchMock);

    const result = await changesApi.list({ since: 12 });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/changes?since=12");
    expect(result).toEqual(feed);
  });

  it("defaults the cursor to 0 and forwards a limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ changes: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    await changesApi.list({ limit: 500 });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/changes?since=0&limit=500");
  });
});

describe("notificationsApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the Web Push configuration", async () => {
    const config = { enabled: true, vapid_public_key: "BPUB" };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => config });
    vi.stubGlobal("fetch", fetchMock);

    const result = await notificationsApi.config();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/notifications/config");
    expect(result).toEqual(config);
  });

  it("registers a web destination with its endpoint and keys", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await notificationsApi.registerDevice({
      channel: "web",
      endpoint: "https://push.example/abc",
      p256dh: "BPUB",
      auth: "AUTH",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/notifications/devices");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      channel: "web",
      endpoint: "https://push.example/abc",
      p256dh: "BPUB",
      auth: "AUTH",
    });
  });

  it("unregisters a web destination by channel and encoded endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await notificationsApi.unregisterDevice("https://push.example/a b");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/notifications/devices?channel=web&endpoint=https%3A%2F%2Fpush.example%2Fa%20b");
    expect(init.method).toBe("DELETE");
  });
});

describe("apiFetch idempotency", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends an Idempotency-Key header when given one", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/tasks/t1", {
      method: "PATCH",
      body: JSON.stringify({ status: "completed" }),
      idempotencyKey: "key-123",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).get("Idempotency-Key")).toBe("key-123");
  });

  it("does not send the header when no key is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/tasks");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).has("Idempotency-Key")).toBe(false);
  });
});

describe("apiFetch validation errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("turns a FastAPI 422 detail list into a readable message", async () => {
    const body = {
      detail: [
        {
          type: "value_error",
          loc: ["body", "email"],
          msg: "value is not a valid email address: The part after the @-sign is a special-use or reserved name.",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        statusText: "Unprocessable Content",
        json: async () => body,
      }),
    );

    await expect(apiFetch("/api/auth/setup", { method: "POST" })).rejects.toThrow(
      /^email: value is not a valid email address/,
    );
  });
});
