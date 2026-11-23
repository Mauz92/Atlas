import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ApiError, ttrpgApi, type Run, type RunCombatant } from "../../api/client";
import { RunPage } from "./RunPage";
import { POLL_MS, moveWithin } from "./runModel";

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return {
    ...actual,
    notesApi: { get: vi.fn().mockResolvedValue({ id: "n1", content: "# Session", revision: 1 }) },
    ttrpgApi: {
      run: vi.fn(),
      campaign: vi.fn(),
      setupRun: vi.fn(),
      startRun: vi.fn(),
      runAction: vi.fn(),
      undoRun: vi.fn(),
    },
  };
});
vi.mock("../NoteEditor", () => ({
  NoteEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="Session note" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
const change = vi.fn();
vi.mock("../../hooks/useNoteAutosave", () => ({
  useNoteAutosave: () => ({ session: { change }, snapshot: null }),
}));

const api = vi.mocked(ttrpgApi);

function combatant(overrides: Partial<RunCombatant> = {}): RunCombatant {
  return {
    id: "g1",
    kind: "npc",
    side: "enemy",
    party_member_id: null,
    name: "Goblin 1",
    ac: 15,
    hp: 7,
    max_hp: 7,
    temp_hp: 0,
    conditions: [],
    condition_reminders: {},
    initiative_mod: 2,
    initiative: 12,
    order_index: 1,
    defeated: false,
    removed: false,
    active: false,
    party_revision: null,
    death_save_successes: 0,
    death_save_failures: 0,
    resources: [],
    attacks: [{ name: "Scimitar", kind: "action", to_hit: 4, damage: "1d6+2" }],
    ...overrides,
  };
}

const brenna = combatant({
  id: "b1",
  kind: "party",
  side: "party",
  party_member_id: "pm1",
  name: "Brenna",
  ac: 17,
  hp: 20,
  max_hp: 28,
  initiative: 18,
  order_index: 0,
  active: true,
  party_revision: 3,
  resources: [{ key: "second-wind", name: "Second Wind", max: 1, used: 0 }],
  attacks: [],
});

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "r1",
    campaign_id: "c1",
    session_id: "s1",
    encounter_id: "e1",
    title: "Goblin ambush",
    status: "active",
    round: 1,
    active_combatant_id: "b1",
    revision: 5,
    outcome: null,
    end_reason: null,
    started_at: null,
    ended_at: null,
    book_reference: "p. 6",
    setup_reminder: "Hide two goblins.",
    combatants: [brenna, combatant()],
    ties: [],
    undo_summary: "Brenna took 8",
    history: [{ seq: 1, kind: "start", summary: "The fight began", combatant_id: null, reversible: false, undone: false, created_at: "2026-11-23T00:00:00Z" }],
    reminders_due: [],
    conditions: ["poisoned", "prone"],
    ...overrides,
  };
}

function page() {
  render(
    <MemoryRouter initialEntries={["/ttrpg/runs/r1"]}>
      <Routes>
        <Route path="/ttrpg/runs/:runId" element={<RunPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  change.mockReset();
  api.run.mockResolvedValue(run());
  api.campaign.mockResolvedValue({
    id: "c1",
    title: "Phandelver",
    sessions: [{ id: "s1", title: "Session 01", note: { missing: false, note_id: "n1" } }],
  } as never);
});

describe("RunPage", () => {
  it("shows the standing, the order and the session note side by side", async () => {
    page();
    expect(await screen.findByRole("heading", { name: "Goblin ambush" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("Round 1: Brenna's turn");
    expect(await screen.findByLabelText("Session note")).toBeInTheDocument();
    const names = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent ?? "");
    expect(names[0]).toMatch(/^Brenna/);
    expect(names[1]).toMatch(/^Goblin 1/);
    expect(screen.getByText("The fight began")).toBeInTheDocument();
  });

  it("types into the note without losing it when switching panes", async () => {
    page();
    const editor = await screen.findByLabelText("Session note");
    fireEvent.change(editor, { target: { value: "# Session\nAmbush!" } });
    expect(change).toHaveBeenCalledWith("# Session\nAmbush!");
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Combat" }));
    expect(screen.getByLabelText("Session note")).toBe(editor); // the same element: never remounted
    expect(screen.getByRole("button", { name: "Combat" })).toHaveAttribute("aria-pressed", "true");
  });

  it("sends a party change with the party revision and a mutation key", async () => {
    api.runAction.mockResolvedValue({ run: run({ revision: 6 }), action: null, replayed: false });
    page();
    await screen.findByRole("heading", { name: "Goblin ambush" });
    fireEvent.change(screen.getByLabelText("Amount for Brenna"), { target: { value: "8" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Damage Brenna" }));
    });
    expect(api.runAction).toHaveBeenCalledTimes(1);
    const [sentRun, body, key] = api.runAction.mock.calls[0];
    expect(sentRun).toMatchObject({ id: "r1", revision: 5 });
    expect(body).toEqual({
      kind: "damage",
      combatant_id: "b1",
      amount: 8,
      party_revisions: { pm1: 3 },
    });
    expect(key).toEqual(expect.any(String));
    await waitFor(() => expect(screen.getByLabelText("Amount for Brenna")).toHaveValue(null));
  });

  it("keeps the failed change and the typed amount, and retries with the same key", async () => {
    api.runAction.mockRejectedValueOnce(new Error("network down"));
    api.runAction.mockResolvedValueOnce({ run: run({ revision: 6 }), action: null, replayed: true });
    page();
    await screen.findByRole("heading", { name: "Goblin ambush" });
    fireEvent.change(screen.getByLabelText("Amount for Goblin 1"), { target: { value: "3" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Damage Goblin 1" }));
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/network down/);
    expect(screen.getByLabelText("Amount for Goblin 1")).toHaveValue(3); // not lost
    await act(async () => {
      fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    });
    expect(api.runAction.mock.calls[1][2]).toBe(api.runAction.mock.calls[0][2]); // same key
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("reloads the fight and explains a conflict instead of retrying a stale change", async () => {
    api.runAction.mockRejectedValue(new ApiError(409, "stale", { detail: { code: "party_stale" } }));
    page();
    await screen.findByRole("heading", { name: "Goblin ambush" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next turn" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed elsewhere/);
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(api.run.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("undoes the last action and explains an undo conflict", async () => {
    api.undoRun.mockRejectedValueOnce(
      new ApiError(409, "x", { detail: { code: "undo_conflict", message: "this can no longer be undone: Brenna was changed outside this fight" } }),
    );
    api.undoRun.mockResolvedValueOnce({ run: run({ revision: 6, undo_summary: null }), action: null, replayed: false });
    page();
    await screen.findByRole("heading", { name: "Goblin ambush" });
    const undo = screen.getByRole("button", { name: /Undo: Brenna took 8/ });
    await act(async () => {
      fireEvent.click(undo);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/can no longer be undone/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Undo: Brenna took 8/ }));
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled());
  });

  it("pauses, shows the paused state and resumes", async () => {
    api.runAction.mockResolvedValueOnce({ run: run({ status: "paused" }), action: null, replayed: false });
    api.runAction.mockResolvedValueOnce({ run: run(), action: null, replayed: false });
    page();
    await screen.findByRole("heading", { name: "Goblin ambush" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    });
    expect(await screen.findByText(/Paused\. Round 1/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next turn" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Damage Goblin 1" })).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    });
    expect(api.runAction.mock.calls[1][1]).toEqual({ kind: "resume" });
  });

  it("ends the fight with an outcome", async () => {
    api.runAction.mockResolvedValue({ run: run({ status: "ended", outcome: "Won." }), action: null, replayed: false });
    page();
    await screen.findByRole("heading", { name: "Goblin ambush" });
    fireEvent.change(screen.getByLabelText(/How did it end/), { target: { value: " Won. " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "End the fight" }));
    });
    expect(api.runAction.mock.calls[0][1]).toEqual({ kind: "end", outcome: "Won." });
    expect(await screen.findByText("Ended: Won.")).toBeInTheDocument();
  });

  it("shows condition reminders, death saves at 0 HP and resource buttons", async () => {
    api.run.mockResolvedValue(
      run({
        reminders_due: [{ combatant_id: "g1", condition: "poisoned", round: 2 }],
        combatants: [
          { ...brenna, hp: 0, death_save_failures: 1 },
          combatant({ conditions: ["poisoned"], condition_reminders: { poisoned: 2 } }),
        ],
      }),
    );
    page();
    await screen.findByRole("heading", { name: "Goblin ambush" });
    expect(screen.getByText(/Reminder: Goblin 1 is still poisoned/)).toBeInTheDocument();
    expect(screen.getByText(/1 failures/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spend Second Wind (Brenna)" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove poisoned from Goblin 1" })).toBeInTheDocument();
  });
});

describe("RunPage live updates", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a change made elsewhere without a reload, and never while a change is in flight", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    page();
    await screen.findByRole("heading", { name: "Goblin ambush" });
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("Round 1: Brenna's turn");
    api.run.mockResolvedValue(
      run({
        revision: 6,
        round: 2,
        combatants: [{ ...brenna, active: false }, combatant({ active: true })],
        active_combatant_id: "g1",
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS + 50);
    });
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("Round 2: Goblin 1's turn");

    // a change in flight is not overwritten by a look
    let finish: (value: never) => void = () => undefined;
    api.runAction.mockReturnValue(new Promise((resolve) => (finish = resolve as never)));
    fireEvent.click(screen.getByRole("button", { name: "Next turn" }));
    const looks = api.run.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    });
    expect(api.run.mock.calls.length).toBe(looks);
    await act(async () => finish({ run: run({ revision: 7 }), action: null, replayed: false } as never));
  });

  it("stops looking once the fight has ended", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.run.mockResolvedValue(run({ status: "ended" }));
    page();
    await screen.findByRole("heading", { name: "Goblin ambush" });
    const looks = api.run.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    expect(api.run.mock.calls.length).toBe(looks);
  });
});

describe("RunPage setup", () => {
  const setupRun = (overrides: Partial<Run> = {}) =>
    run({
      status: "setup",
      round: 0,
      active_combatant_id: null,
      revision: 1,
      undo_summary: null,
      history: [],
      combatants: [
        { ...brenna, initiative: null, order_index: null, active: false },
        combatant({ initiative: null, order_index: null }),
      ],
      ...overrides,
    });

  it("needs every total before the fight can start, then saves and starts in order", async () => {
    api.run.mockResolvedValue(setupRun());
    api.setupRun.mockResolvedValue(setupRun({ revision: 2 }));
    api.startRun.mockResolvedValue(run());
    page();
    await screen.findByRole("heading", { name: "Initiative" });
    const start = screen.getByRole("button", { name: "Start the fight" });
    expect(start).toBeDisabled();
    expect(screen.getByText(/Still needs initiative: Brenna, Goblin 1/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Initiative for Brenna"), { target: { value: "-2" } });
    fireEvent.change(screen.getByLabelText("Initiative for Goblin 1"), { target: { value: "0" } });
    expect(start).toBeEnabled();
    await act(async () => {
      fireEvent.click(start);
    });
    expect(api.setupRun).toHaveBeenCalledWith(expect.objectContaining({ id: "r1", revision: 1 }), {
      initiative: { b1: -2, g1: 0 },
    });
    expect(api.startRun).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }), []);
    expect(await screen.findByText(/Round 1: Brenna's turn/)).toBeInTheDocument();
  });

  it("rejects text and out-of-range totals", async () => {
    api.run.mockResolvedValue(setupRun());
    page();
    await screen.findByRole("heading", { name: "Initiative" });
    fireEvent.change(screen.getByLabelText("Initiative for Brenna"), { target: { value: "101" } });
    fireEvent.change(screen.getByLabelText("Initiative for Goblin 1"), { target: { value: "5" } });
    expect(screen.getByRole("button", { name: "Start the fight" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save initiative" })).toBeDisabled();
  });

  it("lets the DM order a tie and sends that order at the start", async () => {
    const tied = setupRun({
      ties: [["b1", "g1"]],
      combatants: [
        { ...brenna, initiative: 12, order_index: null, active: false },
        combatant({ initiative: 12, order_index: null }),
      ],
    });
    api.run.mockResolvedValue(tied);
    api.startRun.mockResolvedValue(run());
    page();
    await screen.findByRole("heading", { name: "Initiative" });
    fireEvent.click(screen.getByRole("button", { name: "Move Goblin 1 earlier" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start the fight" }));
    });
    expect(api.startRun).toHaveBeenCalledWith(expect.anything(), ["g1", "b1"]);
  });
});

describe("tie ordering helper", () => {
  it("moves one entry and stops at the ends", () => {
    expect(moveWithin(["a", "b", "c"], "b", "up")).toEqual(["b", "a", "c"]);
    expect(moveWithin(["a", "b", "c"], "b", "down")).toEqual(["a", "c", "b"]);
    expect(moveWithin(["a", "b"], "a", "up")).toEqual(["a", "b"]);
    expect(moveWithin(["a", "b"], "z", "down")).toEqual(["a", "b"]);
  });
});
