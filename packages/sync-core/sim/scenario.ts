/**
 * A scripted two-device scenario that runs the REAL sync-core against any {@link ServerPort} and
 * returns the normalised outcomes (statuses, error codes, resolution rules). Running it on the
 * model server and on the real API and comparing the lists is the conformance check: it fails
 * when the model (and with it every simulation result) drifts from the shipped server.
 */
import { SyncEngine, type EngineObserver } from "../src/engine.ts";
import type { Transport } from "../src/ports.ts";
import { fixedClock, seededRandom, sequenceIds, silentLogger } from "../src/testing/fakes.ts";
import { MemoryStore } from "../src/testing/memoryStore.ts";
import { toReq, toResponse, type ServerPort } from "./engineBridge.ts";
import { stripStamp } from "./model/notes.ts";

export async function runScenario(port: ServerPort, devices: [string, string] = ["A", "B"]): Promise<string[]> {
  const outcomes: string[] = [];
  const clock = fixedClock();
  const mk = (cid: string, seed: number) => {
    const store = new MemoryStore();
    const transport: Transport = {
      send: async (request) => toResponse(await port.handle(toReq(request, { "X-Sim-Client": cid }))),
    };
    const observer: EngineObserver = {
      ack: (op, r) => {
        const sync = (r.body as { sync?: { resolution?: { rule: string }[]; conflicts?: { field: string }[] } } | null)?.sync;
        outcomes.push(`${cid} ${op.action} ${op.type} -> ${r.status}` +
          (sync?.resolution?.length ? ` res=${sync.resolution.map((x) => x.rule).join(",")}` : "") +
          (sync?.conflicts?.length ? ` held=${sync.conflicts.map((x) => x.field).join(",")}` : ""));
      },
      refused: (op, r) => {
        const b = r.body as { error?: string; reason?: string; conflict_copy?: { path: string } } | null;
        outcomes.push(`${cid} ${op.action} ${op.type} -> ${r.status} ${b?.error ?? ""}${b?.reason ? `/${b.reason}` : ""}` +
          (b?.conflict_copy ? ` copy=${stripStamp(b.conflict_copy.path)}` : ""));
      },
      undone: (_op, r) => outcomes.push(`${cid} undo -> ${r.status} applied=${String((r.body as { applied: boolean }).applied)}`),
      undoRefused: (_op, r) => outcomes.push(`${cid} undo -> ${r.status} ${(r.body as { error?: string }).error ?? ""}`),
    };
    const engine = new SyncEngine({
      store, transport, clock, ids: sequenceIds(seed), random: seededRandom(seed), logger: silentLogger, observer,
      options: { pullIntervalMs: 1_000_000, pullJitterMs: 0, resyncMinIntervalMs: 0, trackResolutions: true },
    });
    return engine;
  };
  const [a, b] = [mk(devices[0], 11), mk(devices[1], 22)];
  const settle = async () => {
    for (let round = 0; round < 4; round++) {
      for (const e of [a, b]) {
        e.requestPull();
        await e.syncUntilSettled(200);
      }
    }
  };
  const field = async (e: SyncEngine, id: string, name: string) => (await e.view(id))?.fields[name] ?? null;

  // tasks: create, then a text conflict, a simple-field later-wins, edit-wins over delete
  const t = await a.createEntity("task", { title: "t0", description: null });
  await settle();
  await a.updateEntity("task", t, { title: "a1" });
  await b.updateEntity("task", t, { title: "b1" });
  await a.syncUntilSettled(200);
  await b.syncUntilSettled(200);
  await settle();
  outcomes.push(`title=${String(await field(a, t, "title"))}/${String(await field(b, t, "title"))}`);
  await a.updateEntity("task", t, { priority: "high" });
  await b.updateEntity("task", t, { priority: "low" });
  await a.syncUntilSettled(200);
  await b.syncUntilSettled(200);
  await settle();
  outcomes.push(`priority=${String(await field(a, t, "priority"))}/${String(await field(b, t, "priority"))}`);
  const notices = (await b.resolutions()).filter((n) => n.undoable);
  if (notices[0]) {
    await b.undoResolution(notices[0].id);
    await b.syncUntilSettled(200);
    await settle();
    outcomes.push(`after undo priority=${String(await field(a, t, "priority"))}`);
  }
  await a.deleteEntity("task", t);
  await b.updateEntity("task", t, { description: "kept" });
  await a.syncUntilSettled(200);
  await b.syncUntilSettled(200);
  await settle();
  outcomes.push(`revived=${String((await a.view(t))?.deleted === false)} desc=${String(await field(a, t, "description"))}`);

  // a stale delete is refused (the edit wins)
  const p = await a.createEntity("project", { name: "p0", description: null });
  await settle();
  await a.updateEntity("project", p, { description: "edited" });
  await b.deleteEntity("project", p);
  await a.syncUntilSettled(200);
  await b.syncUntilSettled(200);
  await settle();
  outcomes.push(`project alive=${String((await b.view(p))?.deleted === false)}`);

  // notes: disjoint edits merge, overlapping edits become a conflict copy, a taken path is renamed
  const n = await a.createNote("shared", "l1\nl2\nl3\nl4\nl5\n");
  await settle();
  const n2 = await b.createNote("Shared", "other\n"); // same path by case: renamed
  await a.syncUntilSettled(200);
  await b.syncUntilSettled(200);
  await settle();
  await a.editNote(n, "A1\nl2\nl3\nl4\nl5\n");
  await b.editNote(n, "l1\nl2\nl3\nl4\nB5\n");
  await a.syncUntilSettled(200);
  await b.syncUntilSettled(200);
  await settle();
  outcomes.push(`merged=${JSON.stringify((await a.view(n))?.content)}`);
  await a.editNote(n, "X\nl2\nl3\nl4\nB5\n");
  await b.editNote(n, "Y\nl2\nl3\nl4\nB5\n");
  await a.syncUntilSettled(200);
  await b.syncUntilSettled(200);
  await settle();
  outcomes.push(`after overlap=${JSON.stringify((await b.view(n))?.content)} paths=${(await b.views()).filter((v) => v.type === "note" && !v.deleted).map((v) => stripStamp(String(v.fields["path"]))).sort().join("|")}`);
  await a.moveNote(n2, "moved");
  await b.deleteEntity("note", n2);
  await a.syncUntilSettled(200);
  await b.syncUntilSettled(200);
  await settle();
  outcomes.push(`note2 deleted=${String((await a.view(n2))?.deleted)}`);
  return outcomes;
}
