import type { AtlasDesktopApi } from "../desktop";
import { fakeDesktopSync, resolution } from "../../test/syncUi";
import { createEngineSource } from "./engineSource";

function desktop(sync = fakeDesktopSync()): AtlasDesktopApi {
  return {
    snapshot: async () => ({ session: { signedIn: true, baseUrl: "https://a", device: { id: "d-me", name: "This desktop" }, keystoreError: null } }),
    sync,
  } as unknown as AtlasDesktopApi;
}

describe("the engine source (desktop shell)", () => {
  it("pages the locally held entries and knows only its own device name", async () => {
    const all = Array.from({ length: 45 }, (_, i) => resolution({ id: `r${i}` }));
    const source = createEngineSource(desktop(fakeDesktopSync({ resolutions: async () => all })));
    const first = await source.page(null, 20);
    expect(first.items).toHaveLength(20);
    expect(first.next).toBe("20");
    const last = await source.page("40", 20);
    expect(last.items).toHaveLength(5);
    expect(last.next).toBeNull();
    expect(await source.ownDeviceId()).toBe("d-me");
    expect([...(await source.deviceNames()).entries()]).toEqual([["d-me", "This desktop"]]);
  });

  it("maps the engine's answers to the same outcomes as REST", async () => {
    const r = resolution();
    expect((await createEngineSource(desktop()).undo(r, "k")).kind).toBe("undone");
    const refused = fakeDesktopSync({ undo: async () => ({ status: 409, body: { error: "conflict", conflicts: [{ reason: "changed_since" }] } }) });
    expect((await createEngineSource(desktop(refused)).undo(r, "k")).kind).toBe("changed_since");
    const queued = fakeDesktopSync({ undo: async () => ({ queued: true }) });
    const out = await createEngineSource(desktop(queued)).undo(r, "k");
    expect(out).toMatchObject({ kind: "queued", safe: true });
    expect(out.message).toMatch(/saved and will be tried/);
    const broken = fakeDesktopSync({ undo: async () => { throw new Error("bridge"); } });
    expect((await createEngineSource(desktop(broken)).undo(r, "k")).kind).toBe("unreachable");
  });
});
