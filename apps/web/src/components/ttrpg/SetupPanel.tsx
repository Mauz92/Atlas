import { useEffect, useState } from "react";

import { ttrpgApi, type Run } from "../../api/client";
import { moveWithin } from "./runModel";

type Props = {
  run: Run;
  busy: boolean;
  /** Run the work, keep any failure visible, and reload the run afterwards. */
  perform: (work: () => Promise<Run | void>, failure: string) => Promise<boolean>;
};

/** Before the first turn: enter physical initiative totals, settle ties, add extras, start. */
export function SetupPanel({ run, busy, perform }: Props) {
  const live = run.combatants.filter((c) => !c.removed);
  const [totals, setTotals] = useState<Record<string, string>>(() =>
    Object.fromEntries(run.combatants.map((c) => [c.id, c.initiative == null ? "" : String(c.initiative)])),
  );
  const [tieOrder, setTieOrder] = useState<Record<string, string[]>>({});
  const [extra, setExtra] = useState({ name: "", ac: "12", hp: "10", initiative: "10" });

  // Totals typed here are kept until they are saved; a reload of the run fills in saved ones.
  useEffect(() => {
    setTotals((current) => {
      const next: Record<string, string> = {};
      for (const c of run.combatants) {
        next[c.id] = current[c.id] ?? (c.initiative == null ? "" : String(c.initiative));
      }
      return next;
    });
  }, [run.combatants]);

  const parsed = (id: string): number | null => {
    const raw = totals[id];
    if (raw === undefined || raw.trim() === "") return null;
    const value = Number(raw);
    return Number.isInteger(value) && value >= -100 && value <= 100 ? value : NaN;
  };
  const invalid = live.some((c) => Number.isNaN(parsed(c.id)));
  const dirty = live.some((c) => parsed(c.id) !== c.initiative);
  const missing = live.filter((c) => parsed(c.id) === null);

  function payload(): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const c of live) {
      const value = parsed(c.id);
      if (value !== c.initiative && !Number.isNaN(value)) out[c.id] = value;
    }
    return out;
  }

  // Ties are found from what is typed, not only from what was saved, so they show up at once.
  const typedTies = new Map<number, string[]>();
  for (const c of live) {
    const value = parsed(c.id);
    if (value === null || Number.isNaN(value)) continue;
    typedTies.set(value, [...(typedTies.get(value) ?? []), c.id]);
  }
  const groups = [...typedTies.entries()]
    .filter(([, ids]) => ids.length > 1)
    .sort((a, b) => b[0] - a[0])
    .map(([, ids]) => {
      const saved = tieOrder[[...ids].sort().join(",")];
      return saved && saved.length === ids.length ? saved : ids;
    });
  const nameOf = (id: string) => run.combatants.find((c) => c.id === id)?.name ?? id;

  async function start() {
    const initiative = payload();
    await perform(async () => {
      // one request after the other, the second built on the run the first returned
      const current = Object.keys(initiative).length > 0 ? await ttrpgApi.setupRun(run, { initiative }) : run;
      return ttrpgApi.startRun(current, groups.flat());
    }, "Could not start the fight");
  }

  return (
    <section aria-labelledby="ttrpg-setup-title" className="ttrpg-setup">
      <h2 id="ttrpg-setup-title">Initiative</h2>
      <p className="muted">Enter the totals rolled at the table. Zero and negative totals are fine.</p>
      <ul>
        {live.map((c) => (
          <li key={c.id} className="ttrpg-row">
            <label>
              Initiative for {c.name}
              <input
                type="number"
                min={-100}
                max={100}
                value={totals[c.id] ?? ""}
                onChange={(e) => setTotals({ ...totals, [c.id]: e.target.value })}
              />
            </label>
            <span className="muted">
              modifier {c.initiative_mod >= 0 ? "+" : ""}
              {c.initiative_mod} · AC {c.ac} · HP {c.hp}/{c.max_hp}
            </span>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() =>
                void perform(
                  () => ttrpgApi.setupRun(run, { set_removed: { [c.id]: true } }),
                  "Could not remove the combatant",
                )
              }
            >
              Leave out {c.name}
            </button>
          </li>
        ))}
        {run.combatants
          .filter((c) => c.removed)
          .map((c) => (
            <li key={c.id} className="muted">
              {c.name} (left out){" "}
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() =>
                  void perform(
                    () => ttrpgApi.setupRun(run, { set_removed: { [c.id]: false } }),
                    "Could not bring the combatant back",
                  )
                }
              >
                Bring back {c.name}
              </button>
            </li>
          ))}
      </ul>
      {groups.length > 0 && (
        <fieldset>
          <legend>Ties: choose who acts first</legend>
          {groups.map((ids) => (
            <ol key={ids.join(",")}>
              {ids.map((id) => (
                <li key={id}>
                  {nameOf(id)}{" "}
                  <button
                    type="button"
                    className="ghost"
                    aria-label={`Move ${nameOf(id)} earlier`}
                    onClick={() => setTieOrder({ ...tieOrder, [[...ids].sort().join(",")]: moveWithin(ids, id, "up") })}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    aria-label={`Move ${nameOf(id)} later`}
                    onClick={() => setTieOrder({ ...tieOrder, [[...ids].sort().join(",")]: moveWithin(ids, id, "down") })}
                  >
                    ↓
                  </button>
                </li>
              ))}
            </ol>
          ))}
        </fieldset>
      )}
      <form
        className="ttrpg-row"
        onSubmit={(event) => {
          event.preventDefault();
          void perform(
            () =>
              ttrpgApi.setupRun(run, {
                add: [
                  {
                    name: extra.name.trim(),
                    ac: Number(extra.ac),
                    hp: Number(extra.hp),
                    initiative: extra.initiative === "" ? null : Number(extra.initiative),
                  },
                ],
              }),
            "Could not add the combatant",
          ).then((ok) => ok && setExtra({ ...extra, name: "" }));
        }}
      >
        <label>
          Extra combatant
          <input value={extra.name} maxLength={120} onChange={(e) => setExtra({ ...extra, name: e.target.value })} />
        </label>
        <label>
          AC
          <input type="number" value={extra.ac} onChange={(e) => setExtra({ ...extra, ac: e.target.value })} />
        </label>
        <label>
          HP
          <input type="number" value={extra.hp} onChange={(e) => setExtra({ ...extra, hp: e.target.value })} />
        </label>
        <button type="submit" disabled={busy || !extra.name.trim()}>
          Add combatant
        </button>
      </form>
      {missing.length > 0 && (
        <p className="muted">Still needs initiative: {missing.map((c) => c.name).join(", ")}</p>
      )}
      <div className="ttrpg-actions">
        <button
          type="button"
          disabled={busy || invalid || !dirty}
          onClick={() =>
            void perform(() => ttrpgApi.setupRun(run, { initiative: payload() }), "Could not save initiative")
          }
        >
          Save initiative
        </button>
        <button
          type="button"
          disabled={busy || invalid || missing.length > 0 || live.length === 0}
          onClick={() => void start()}
        >
          Start the fight
        </button>
      </div>
    </section>
  );
}
