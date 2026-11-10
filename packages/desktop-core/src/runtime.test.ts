import { SyncEngine } from "../../sync-core/src/index.ts";
import { ModelServer } from "../../sync-core/sim/model/server.ts";
import type { HttpPortRequest, HttpPortResponse } from "./ports.ts";
import { DesktopRuntime } from "./runtime.ts";
import { SqliteLocalStore } from "./sqliteStore.ts";
import { createPortTransport } from "./transport.ts";
import { createFakePlatform, FakeRowDb, modelHttp, settle, type FakePlatform } from "./testing/index.ts";

const HOUR = 3_600_000;

interface Rig {
  p: FakePlatform;
  server: ModelServer;
  rt: DesktopRuntime;
  /** answers for paths the model server does not know, and fault switches */
  hooks: { waitAnswers: HttpPortResponse[]; status: number | null };
  waits: HttpPortRequest[];
}

function rig(options: ConstructorParameters<typeof DesktopRuntime>[1] = {}): Rig {
  const p = createFakePlatform(21);
  const server = new ModelServer({}, { reminders: true, clock: () => p.timers.wall });
  const hooks: Rig["hooks"] = { waitAnswers: [], status: null };
  const waits: HttpPortRequest[] = [];
  const model = modelHttp(server, {
    before: (req) => {
      if (hooks.status !== null) return { status: hooks.status, headers: {}, body: JSON.stringify({ error: hooks.status === 401 ? "token_revoked" : "upgrade" }) };
      if (req.path.startsWith("/api/sync/wait")) {
        waits.push(req);
        return hooks.waitAnswers.shift() ?? { status: 200, headers: {}, body: JSON.stringify({ head: 0, changed: false }) };
      }
      return null;
    },
  });
  p.http.handler = (req) => model.request(req);
  const rt = new DesktopRuntime(p, { tickMs: 1000, schedulerTickMs: 30_000, fullScanMs: 5 * 60_000, liveWaitSeconds: 25, debounceMs: 50, ...options });
  return { p, server, rt, hooks, waits };
}

const signIn = (r: Rig) =>
  r.rt.signIn({ baseUrl: "https://atlas.example.org", email: "me@example.org", password: "pw", deviceName: "Linux desktop" });

/** A second device that creates a task with a due date through the real engine. */
async function otherDevice(r: Rig): Promise<SyncEngine> {
  const q = createFakePlatform(99);
  q.timers = r.p.timers;
  return new SyncEngine({
    store: new SqliteLocalStore(new FakeRowDb()),
    transport: createPortTransport(modelHttp(r.server)),
    clock: r.p.timers,
    ids: q.crypto,
    random: { next: () => 0.5 },
    options: { reminders: true },
  });
}

describe("desktop runtime over fake platform adapters", () => {
  it("starts signed out when there is no token, then signs in and syncs", async () => {
    const r = rig();
    const snap = await r.rt.start();
    expect(snap.phase).toBe("signed_out");
    expect(r.p.tray.closeToTray).toBe(true); // ADR-0068 Q2: close-to-tray is on by default
    const bad = await r.rt.signIn({ baseUrl: "http://192.0.2.7", email: "a@b.c", password: "x", deviceName: "d" });
    expect(bad).toMatchObject({ ok: false, failure: "insecure_url" });
    expect((await r.p.session.info()).signedIn).toBe(false);
    const ok = await signIn(r);
    expect(ok.ok).toBe(true);
    await r.p.timers.advance(3000);
    const after = await r.rt.snapshot();
    expect(after.phase).toBe("running");
    expect(after.sync?.state).toBe("idle");
    expect(after.session?.signedIn).toBe(true);
    await r.rt.stop();
  });

  it("the token is never given to the engine or the webview: requests carry no Authorization header", async () => {
    const r = rig();
    await r.rt.start();
    await signIn(r);
    await r.p.timers.advance(5000);
    expect(r.p.http.requests.length).toBeGreaterThan(0);
    expect(r.p.http.requests.every((q) => !Object.keys(q.headers).some((h) => h.toLowerCase() === "authorization"))).toBe(true);
    expect(JSON.stringify(await r.rt.snapshot())).not.toContain("secret-token");
    await r.rt.stop();
  });

  it("a reminder synced from another device fires a desktop notification at its time, once", async () => {
    const r = rig();
    await r.rt.start();
    await signIn(r);
    const other = await otherDevice(r);
    await other.createEntity("task", { title: "Pay the rent", description: null, due_at: new Date(r.p.timers.wall + 2 * HOUR).toISOString(), status: "inbox" });
    await other.syncUntilSettled();
    await r.p.timers.advance(40_000); // the desktop pulls and arms
    expect(r.p.notifier.shown).toHaveLength(0);
    await r.p.timers.advance(2 * HOUR);
    expect(r.p.notifier.shown).toHaveLength(1);
    expect(r.p.notifier.shown[0]!.body + r.p.notifier.shown[0]!.title).toContain("Pay the rent");
    await r.p.timers.advance(HOUR); // no second show for the same key
    expect(r.p.notifier.shown).toHaveLength(1);
    await r.rt.stop();
  });

  it("generic content mode and the reminders switch are per-device settings that persist", async () => {
    const r = rig();
    await r.rt.start();
    await signIn(r);
    await r.rt.updateSettings({ contentMode: "generic" });
    const other = await otherDevice(r);
    await other.createEntity("task", { title: "Secret errand", description: null, due_at: new Date(r.p.timers.wall + HOUR).toISOString(), status: "inbox" });
    await other.syncUntilSettled();
    await r.p.timers.advance(2 * HOUR);
    expect(r.p.notifier.shown).toHaveLength(1);
    expect(JSON.stringify(r.p.notifier.shown)).not.toContain("Secret errand");
    await r.rt.stop();
    // a restarted runtime over the same database reads the settings back
    const again = new DesktopRuntime(r.p, { tickMs: 1000 });
    const snap = await again.start();
    expect(snap.settings.contentMode).toBe("generic");
    await again.updateSettings({ remindersEnabled: false, closeToTray: false });
    expect(r.p.tray.closeToTray).toBe(false);
    await again.stop();
  });

  it("a 401 from the server signs the device out: services stop, the token is forgotten, the sign-in page is shown", async () => {
    const r = rig();
    await r.rt.start();
    await signIn(r);
    await r.p.timers.advance(3000);
    r.hooks.status = 401;
    await r.p.timers.advance(5000);
    const snap = await r.rt.snapshot();
    expect(snap.phase).toBe("signed_out");
    expect(snap.reason).toBe("token_revoked");
    expect((await r.p.session.info()).signedIn).toBe(false);
    expect(r.p.lifecycle.signInPage).toEqual(["signed_out"]);
    const before = r.p.http.requests.length;
    await r.p.timers.advance(60_000);
    expect(r.p.http.requests.length).toBe(before); // nothing more is sent
  });

  it("a 426 stops syncing in an update-required state and keeps the token", async () => {
    const r = rig();
    await r.rt.start();
    await signIn(r);
    r.hooks.status = 426;
    await r.p.timers.advance(5000);
    const snap = await r.rt.snapshot();
    expect(snap.phase).toBe("update_required");
    expect((await r.p.session.info()).signedIn).toBe(true);
    expect(r.p.lifecycle.signInPage).toEqual(["update_required"]);
  });

  it("the live connection turns a 'changed' answer into a pull, and rate-limits pulls to one per 5 seconds", async () => {
    const r = rig();
    await r.rt.start();
    await signIn(r);
    await r.p.timers.advance(3000);
    const other = await otherDevice(r);
    await other.createEntity("task", { title: "from elsewhere", description: null, due_at: null, status: "inbox" });
    await other.syncUntilSettled();
    r.hooks.waitAnswers.push({ status: 200, headers: {}, body: JSON.stringify({ head: 5, changed: true }) });
    await r.p.timers.advance(2000);
    const views = await r.rt.syncEngine!.views();
    expect(views.some((v) => v.fields["title"] === "from elsewhere")).toBe(true);
    expect(r.waits.length).toBeGreaterThan(0);
    expect(r.waits[0]!.path).toMatch(/^\/api\/sync\/wait\?since=\d+&timeout=25$/);
    await r.rt.stop();
  });

  it("a long poll that fails backs off instead of spinning", async () => {
    const r = rig();
    await r.rt.start();
    await signIn(r);
    r.hooks.waitAnswers.push(...Array.from({ length: 50 }, () => ({ status: 500, headers: {}, body: "" })));
    await r.p.timers.advance(60_000);
    expect(r.waits.length).toBeLessThan(12);
    await r.rt.stop();
  });

  it("wake-up and the tray menu act: wake re-pulls, 'open' shows the window", async () => {
    const r = rig();
    await r.rt.start();
    await signIn(r);
    await r.p.timers.advance(3000);
    r.p.lifecycle.fireWake();
    await settle();
    r.p.tray.click("open");
    expect(r.p.lifecycle.windowShown).toBe(1);
    await r.rt.stop();
  });

  it("signing in again as the same account keeps queued edits; another account starts empty", async () => {
    const r = rig();
    await r.rt.start();
    await signIn(r);
    r.p.http.offline = true;
    await r.rt.syncEngine!.createEntity("task", { title: "offline task", description: null, due_at: null, status: "inbox" });
    await r.rt.signOut();
    r.p.http.offline = false;
    await signIn(r);
    expect((await r.rt.syncEngine!.views()).some((v) => v.fields["title"] === "offline task")).toBe(true);
    await r.rt.signOut();
    await r.rt.signIn({ baseUrl: "https://atlas.example.org", email: "someone-else@example.org", password: "pw", deviceName: "d" });
    expect((await r.rt.syncEngine!.views()).some((v) => v.fields["title"] === "offline task")).toBe(false);
    await r.rt.stop();
  });

  it("autostart is opt-in: asked once, default off", async () => {
    const r = rig();
    await r.rt.start();
    expect(r.p.autostart.enabled).toBe(false);
    expect((await r.rt.snapshot()).settings.autostartAsked).toBe(false);
    await r.rt.answerAutostart(true);
    expect(r.p.autostart.enabled).toBe(true);
    expect((await r.rt.snapshot()).settings.autostartAsked).toBe(true);
  });

  it("an unusable keystore is reported, not hidden", async () => {
    const r = rig();
    r.p.session.keystoreError = "no Secret Service";
    const snap = await r.rt.start();
    expect(snap).toMatchObject({ phase: "signed_out", reason: "keystore_unavailable" });
    expect(await signIn(r)).toMatchObject({ ok: false, failure: "keystore_unavailable" });
  });
});
