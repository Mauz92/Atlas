import { useState } from "react";

import type { Run, RunActionBody, RunCombatant } from "../../api/client";
import { HpBar } from "./HpBar";

type Props = {
  run: Run;
  combatant: RunCombatant;
  busy: boolean;
  act: (body: RunActionBody, failure: string) => Promise<boolean>;
  /** Open this rule in the side panels (a condition's name). */
  onRule?: (ruleId: string) => void;
};

const KIND_LABEL = { party: "Party", ally: "Ally", enemy: "Enemy" } as const;

/** Commit a typed whole number on Enter or when leaving the field. */
function commitOnLeave(event: React.KeyboardEvent<HTMLInputElement>) {
  if (event.key === "Enter") event.currentTarget.blur();
}

/**
 * One combatant of a running fight, played by hand: you type or nudge the numbers, you say who is
 * acting and who is out. Nothing is subtracted, skipped or ended for you.
 */
export function CombatantRow({ run, combatant: c, busy, act, onRule }: Props) {
  const [until, setUntil] = useState("");
  const live = run.status === "active";
  const can = live && !busy;
  const acting = c.id === run.active_combatant_id && !c.removed;
  const due = run.reminders_due.filter((r) => r.combatant_id === c.id);
  const available = run.conditions.filter((name) => !c.conditions.includes(name));

  function setHp(raw: string) {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(value) || value < 0 || value > c.max_hp || value === c.hp) return;
    void act({ kind: "set_hp", combatant_id: c.id, hp: value }, "Could not change hit points");
  }
  function bump(delta: number) {
    const next = Math.max(0, Math.min(c.max_hp, c.hp + delta));
    if (next !== c.hp) void act({ kind: "set_hp", combatant_id: c.id, hp: next }, "Could not change hit points");
  }
  function setTemp(raw: string) {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(value) || value < 0 || value > 9999 || value === c.temp_hp) return;
    void act({ kind: "set_temp_hp", combatant_id: c.id, amount: value }, "Could not change temporary hit points");
  }
  function setInitiative(raw: string) {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(value) || value < -100 || value > 100 || value === c.initiative) return;
    void act({ kind: "set_initiative", combatant_id: c.id, initiative: value }, "Could not change initiative");
  }

  return (
    <li
      className={`tt-row-c ${c.side === "party" ? "party" : c.side}${acting ? " acting" : ""}${c.removed ? " out" : ""}`}
      aria-current={acting ? "true" : undefined}
    >
      <div className="tt-d20">
        <span className="tt-die">
          <input
            key={`init-${c.initiative}`}
            type="number"
            aria-label={`Initiative of ${c.name}`}
            defaultValue={c.initiative ?? ""}
            disabled={!can}
            onBlur={(e) => setInitiative(e.target.value)}
            onKeyDown={commitOnLeave}
          />
        </span>
        <button
          type="button"
          aria-pressed={acting}
          disabled={!can || acting || c.removed}
          title="Hand the turn to this combatant"
          onClick={() => void act({ kind: "set_active", combatant_id: c.id }, "Could not change whose turn it is")}
        >
          {acting ? "Acting" : "Set turn"}
        </button>
      </div>

      <div className="tt-nameline">
        <h3 className="tt-name">{c.name}</h3>
        <span className="tt-badges">
          <span className="tt-kind">{KIND_LABEL[c.side]}</span>
          <span className="tt-ac" role="img" aria-label={`Armor Class ${c.ac}`}>
            {c.ac}
          </span>
        </span>
      </div>

      <HpBar name={c.name} hp={c.hp} max={c.max_hp} temp={c.temp_hp} downLabel={c.kind === "party" ? "Down" : "0 HP"} />

      <div className="tt-controls">
        <span className="tt-hp-ctl" role="group" aria-label={`Hit points of ${c.name}`}>
          <button type="button" className="dn" disabled={!can || c.removed} aria-label={`Minus 5 HP for ${c.name}`} onClick={() => bump(-5)}>
            -5
          </button>
          <button type="button" className="dn" disabled={!can || c.removed} aria-label={`Minus 1 HP for ${c.name}`} onClick={() => bump(-1)}>
            -1
          </button>
          <input
            key={`hp-${c.hp}`}
            type="number"
            min={0}
            max={c.max_hp}
            aria-label={`Current HP of ${c.name}`}
            defaultValue={c.hp}
            disabled={!can || c.removed}
            onBlur={(e) => setHp(e.target.value)}
            onKeyDown={commitOnLeave}
          />
          <span className="of">/ {c.max_hp}</span>
          <button type="button" className="up" disabled={!can || c.removed} aria-label={`Plus 1 HP for ${c.name}`} onClick={() => bump(1)}>
            +1
          </button>
          <button type="button" className="up" disabled={!can || c.removed} aria-label={`Plus 5 HP for ${c.name}`} onClick={() => bump(5)}>
            +5
          </button>
        </span>
        <label>
          Temp
          <input
            key={`temp-${c.temp_hp}`}
            type="number"
            min={0}
            aria-label={`Temporary HP of ${c.name}`}
            defaultValue={c.temp_hp}
            disabled={!can || c.removed}
            onBlur={(e) => setTemp(e.target.value)}
            onKeyDown={commitOnLeave}
          />
        </label>
        <label>
          <input
            type="checkbox"
            aria-label={`${c.name} is out of the fight`}
            checked={c.removed}
            disabled={!live || busy}
            onChange={(e) =>
              void act(
                { kind: e.target.checked ? "remove_combatant" : "restore_combatant", combatant_id: c.id },
                "Could not change whether they are in the fight",
              )
            }
          />
          Out of the fight
        </label>
      </div>

      <div className="tt-cond">
        {c.conditions.map((name) => (
          <span key={name} className="tt-chip">
            {onRule ? (
              <button type="button" aria-label={`Read the rule for ${name}`} onClick={() => onRule(name)}>
                {name}
              </button>
            ) : (
              <span>{name}</span>
            )}
            {c.condition_reminders[name] ? <span>(until round {c.condition_reminders[name]})</span> : null}
            <button
              type="button"
              className="x"
              disabled={!can || c.removed}
              aria-label={`Remove ${name} from ${c.name}`}
              onClick={() => void act({ kind: "remove_condition", combatant_id: c.id, condition: name }, "Could not remove the condition")}
            >
              ×
            </button>
          </span>
        ))}
        {!c.removed && live && (
          <>
            <select
              aria-label={`Add a condition to ${c.name}`}
              value=""
              disabled={!can}
              onChange={(e) => {
                if (!e.target.value) return;
                void act(
                  {
                    kind: "add_condition",
                    combatant_id: c.id,
                    condition: e.target.value,
                    ...(until ? { expires_round: Number(until) } : {}),
                  },
                  "Could not add the condition",
                ).then((ok) => ok && setUntil(""));
              }}
            >
              <option value="">+ Condition</option>
              {available.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <label>
              until round
              <input
                type="number"
                min={1}
                max={999}
                aria-label={`Until round, for the next condition on ${c.name}`}
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
            </label>
          </>
        )}
      </div>
      {due.map((r) => (
        <p key={r.condition} role="status" className="tt-reminder">
          Reminder: {c.name} is still {r.condition} (due by round {r.round}).
        </p>
      ))}

      {c.kind === "party" && c.hp === 0 && !c.removed && (
        <div className="tt-controls" role="group" aria-label={`Death saves for ${c.name}`}>
          <span>
            Death saves: {c.death_save_successes} successes, {c.death_save_failures} failures
          </span>
          {(["success", "failure", "reset"] as const).map((mark) => (
            <button
              key={mark}
              type="button"
              className="ghost"
              disabled={!can}
              onClick={() => void act({ kind: "death_save", combatant_id: c.id, death_save: mark }, "Could not mark the death save")}
            >
              {mark === "reset" ? "Clear saves" : `Mark ${mark}`}
            </button>
          ))}
        </div>
      )}
      {c.resources.length > 0 && !c.removed && (
        <ul className="tt-controls" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {c.resources.map((r) => (
            <li key={r.key} className="tt-controls">
              <span>
                {r.name}: {r.max - r.used}/{r.max} left
              </span>
              <button
                type="button"
                className="ghost"
                disabled={!can || r.used >= r.max}
                onClick={() => void act({ kind: "spend_resource", combatant_id: c.id, resource_key: r.key, delta: 1 }, "Could not spend it")}
              >
                Spend {r.name} ({c.name})
              </button>
              <button
                type="button"
                className="ghost"
                disabled={!can || r.used <= 0}
                onClick={() => void act({ kind: "spend_resource", combatant_id: c.id, resource_key: r.key, delta: -1 }, "Could not restore it")}
              >
                Restore {r.name} ({c.name})
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
