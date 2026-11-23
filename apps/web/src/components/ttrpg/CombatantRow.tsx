import { useState } from "react";

import type { Run, RunActionBody, RunCombatant } from "../../api/client";

type Props = {
  run: Run;
  combatant: RunCombatant;
  busy: boolean;
  act: (body: RunActionBody, failure: string) => Promise<boolean>;
  /** Open this rule in the rules pane (a condition's name). */
  onRule?: (ruleId: string) => void;
};

/** One combatant of a running fight: stats, quick HP changes, conditions, defeat and removal. */
export function CombatantRow({ run, combatant: c, busy, act, onRule }: Props) {
  const [amount, setAmount] = useState("");
  const [condition, setCondition] = useState("");
  const [until, setUntil] = useState("");
  const value = Number(amount);
  const valid = amount !== "" && Number.isInteger(value) && value >= 0;
  const live = run.status === "active";
  const canAct = live && !busy && !c.removed;
  const down = c.hp === 0;
  const due = run.reminders_due.filter((r) => r.combatant_id === c.id);

  const hp = (kind: "damage" | "heal" | "temp_hp") =>
    void act({ kind, combatant_id: c.id, amount: value }, "Could not change hit points").then(
      (ok) => ok && setAmount(""),
    );

  return (
    <li
      className={`ttrpg-combatant${c.active ? " active" : ""}${c.defeated ? " defeated" : ""}${c.removed ? " removed" : ""}`}
      aria-current={c.active ? "true" : undefined}
    >
      <h3>
        {c.name}
        <span className="muted">
          {" "}
          · {c.side === "party" ? "party" : c.side}
          {c.initiative != null ? ` · initiative ${c.initiative}` : ""}
          {c.defeated ? " · defeated" : ""}
          {c.removed ? " · out of the fight" : ""}
        </span>
      </h3>
      <p>
        AC {c.ac} · HP <strong>{c.hp}</strong>/{c.max_hp}
        {c.temp_hp > 0 ? ` (+${c.temp_hp} temp)` : ""}
      </p>
      <progress value={c.hp} max={c.max_hp} aria-label={`${c.name} hit points`} />
      {c.attacks.length > 0 && (
        <p className="muted">
          {c.attacks
            .filter((a) => a.kind === "action")
            .map((a) => `${a.name}${a.to_hit != null ? ` +${a.to_hit}` : ""}${a.damage ? ` (${a.damage})` : ""}`)
            .join(" · ")}
        </p>
      )}
      {c.conditions.length > 0 && (
        <ul className="ttrpg-chips" aria-label={`Conditions of ${c.name}`}>
          {c.conditions.map((name) => (
            <li key={name}>
              {onRule ? (
                <button type="button" className="ghost" aria-label={`Read the rule for ${name}`} onClick={() => onRule(name)}>
                  {name}
                </button>
              ) : (
                name
              )}
              {c.condition_reminders[name] ? ` (until round ${c.condition_reminders[name]})` : ""}
              <button
                type="button"
                className="ghost"
                disabled={!canAct}
                aria-label={`Remove ${name} from ${c.name}`}
                onClick={() => void act({ kind: "remove_condition", combatant_id: c.id, condition: name }, "Could not remove the condition")}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {due.map((r) => (
        <p key={r.condition} role="status" className="ttrpg-reminder">
          Reminder: {c.name} is still {r.condition} (was due by round {r.round}).
        </p>
      ))}
      {!c.removed && (
        <div className="ttrpg-row">
          <label>
            <span className="sr-only">Amount for {c.name}</span>
            <input
              type="number"
              min={0}
              placeholder="Amount"
              value={amount}
              disabled={!live}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <button type="button" disabled={!canAct || !valid} onClick={() => hp("damage")}>
            Damage {c.name}
          </button>
          <button type="button" disabled={!canAct || !valid} onClick={() => hp("heal")}>
            Heal {c.name}
          </button>
          <button type="button" className="ghost" disabled={!canAct || !valid} onClick={() => hp("temp_hp")}>
            Temp HP for {c.name}
          </button>
        </div>
      )}
      {!c.removed && live && (
        <div className="ttrpg-row">
          <label>
            Condition for {c.name}
            <select value={condition} onChange={(e) => setCondition(e.target.value)}>
              <option value="">Choose…</option>
              {run.conditions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Until round
            <input type="number" min={1} max={999} value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
          <button
            type="button"
            className="ghost"
            disabled={!canAct || !condition}
            onClick={() =>
              void act(
                {
                  kind: "add_condition",
                  combatant_id: c.id,
                  condition,
                  ...(until ? { expires_round: Number(until) } : {}),
                },
                "Could not add the condition",
              ).then((ok) => ok && (setCondition(""), setUntil("")))
            }
          >
            Add condition to {c.name}
          </button>
        </div>
      )}
      {c.kind === "party" && down && !c.removed && (
        <div className="ttrpg-row" role="group" aria-label={`Death saves for ${c.name}`}>
          <span>
            Death saves: {c.death_save_successes} successes, {c.death_save_failures} failures
          </span>
          {(["success", "failure", "reset"] as const).map((mark) => (
            <button
              key={mark}
              type="button"
              className="ghost"
              disabled={!canAct}
              onClick={() => void act({ kind: "death_save", combatant_id: c.id, death_save: mark }, "Could not mark the death save")}
            >
              {mark === "reset" ? "Clear saves" : `Mark ${mark}`}
            </button>
          ))}
        </div>
      )}
      {c.resources.length > 0 && !c.removed && (
        <ul className="ttrpg-resources">
          {c.resources.map((r) => (
            <li key={r.key}>
              {r.name}: {r.max - r.used}/{r.max} left
              <button
                type="button"
                className="ghost"
                disabled={!canAct || r.used >= r.max}
                onClick={() => void act({ kind: "spend_resource", combatant_id: c.id, resource_key: r.key, delta: 1 }, "Could not spend it")}
              >
                Spend {r.name} ({c.name})
              </button>
              <button
                type="button"
                className="ghost"
                disabled={!canAct || r.used <= 0}
                onClick={() => void act({ kind: "spend_resource", combatant_id: c.id, resource_key: r.key, delta: -1 }, "Could not restore it")}
              >
                Restore {r.name} ({c.name})
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="ttrpg-actions">
        {c.kind === "npc" && !c.removed && (
          <button
            type="button"
            className="ghost"
            disabled={!canAct}
            onClick={() => void act({ kind: "set_defeated", combatant_id: c.id, defeated: !c.defeated }, "Could not change the status")}
          >
            {c.defeated ? `Revive ${c.name}` : `Mark ${c.name} defeated`}
          </button>
        )}
        {c.removed ? (
          <button
            type="button"
            className="ghost"
            disabled={!live || busy}
            onClick={() => void act({ kind: "restore_combatant", combatant_id: c.id }, "Could not bring them back")}
          >
            Bring back {c.name}
          </button>
        ) : (
          <button
            type="button"
            className="ghost"
            disabled={!canAct}
            onClick={() => void act({ kind: "remove_combatant", combatant_id: c.id }, "Could not remove them")}
          >
            Remove {c.name}
          </button>
        )}
      </div>
    </li>
  );
}
