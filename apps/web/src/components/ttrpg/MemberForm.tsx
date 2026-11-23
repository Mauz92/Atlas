import { useState } from "react";

import type { PartyCard } from "../../api/client";

type Props = {
  initial?: PartyCard;
  submitLabel: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (card: PartyCard) => void;
  onCancel?: () => void;
};

const EMPTY: PartyCard = {
  role: "pc",
  name: "",
  ac: 10,
  max_hp: 10,
  initiative_mod: 0,
  attacks: [],
  abilities: [],
  resources: [],
};

function optional(value: string): number | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : Number(trimmed);
}

function keyOf(name: string, taken: Set<string>): string {
  const base =
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "resource";
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}-${n}`;
  return key;
}

/** Create or edit a party card (name, defences, attacks, abilities and limited-use resources). */
export function MemberForm({ initial, submitLabel, busy, error, onSubmit, onCancel }: Props) {
  const [card, setCard] = useState<PartyCard>(initial ?? EMPTY);
  const [level, setLevel] = useState(initial?.level?.toString() ?? "");
  const [speed, setSpeed] = useState(initial?.speed?.toString() ?? "");
  const [passive, setPassive] = useState(initial?.passive_perception?.toString() ?? "");

  const set = <K extends keyof PartyCard>(key: K, value: PartyCard[K]) =>
    setCard((current) => ({ ...current, [key]: value }));
  const number = (value: string, fallback = 0) => (value === "" ? fallback : Number(value));

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    onSubmit({
      ...card,
      level: optional(level),
      speed: optional(speed),
      passive_perception: optional(passive),
    });
  }

  return (
    <form className="ttrpg-member-form" onSubmit={submit}>
      <label>
        Name
        <input value={card.name} maxLength={120} required onChange={(e) => set("name", e.target.value)} />
      </label>
      <label>
        Role
        <select value={card.role} onChange={(e) => set("role", e.target.value as PartyCard["role"])}>
          <option value="pc">Player character</option>
          <option value="companion">Companion</option>
        </select>
      </label>
      <label>
        Level
        <input type="number" min={1} max={20} value={level} onChange={(e) => setLevel(e.target.value)} />
      </label>
      <label>
        AC
        <input type="number" min={0} max={40} required value={card.ac} onChange={(e) => set("ac", number(e.target.value))} />
      </label>
      <label>
        Max HP
        <input type="number" min={1} max={9999} required value={card.max_hp} onChange={(e) => set("max_hp", number(e.target.value, 1))} />
      </label>
      <label>
        Speed
        <input type="number" min={0} max={500} value={speed} onChange={(e) => setSpeed(e.target.value)} />
      </label>
      <label>
        Initiative modifier
        <input type="number" min={-10} max={30} value={card.initiative_mod ?? 0} onChange={(e) => set("initiative_mod", number(e.target.value))} />
      </label>
      <label>
        Passive Perception
        <input type="number" min={0} max={40} value={passive} onChange={(e) => setPassive(e.target.value)} />
      </label>

      <fieldset>
        <legend>Attacks</legend>
        {(card.attacks ?? []).map((attack, index) => (
          <div key={index} className="ttrpg-row">
            <input
              aria-label={`Attack ${index + 1} name`}
              placeholder="Name"
              value={attack.name}
              onChange={(e) =>
                set("attacks", (card.attacks ?? []).map((a, i) => (i === index ? { ...a, name: e.target.value } : a)))
              }
            />
            <input
              aria-label={`Attack ${index + 1} to hit`}
              type="number"
              placeholder="+hit"
              value={attack.to_hit ?? ""}
              onChange={(e) =>
                set(
                  "attacks",
                  (card.attacks ?? []).map((a, i) => (i === index ? { ...a, to_hit: optional(e.target.value) } : a)),
                )
              }
            />
            <input
              aria-label={`Attack ${index + 1} damage`}
              placeholder="Damage"
              value={attack.damage ?? ""}
              onChange={(e) =>
                set("attacks", (card.attacks ?? []).map((a, i) => (i === index ? { ...a, damage: e.target.value } : a)))
              }
            />
            <button type="button" className="ghost" onClick={() => set("attacks", (card.attacks ?? []).filter((_, i) => i !== index))}>
              Remove attack {index + 1}
            </button>
          </div>
        ))}
        <button type="button" className="ghost" onClick={() => set("attacks", [...(card.attacks ?? []), { name: "", damage: "", notes: "" }])}>
          Add attack
        </button>
      </fieldset>

      <fieldset>
        <legend>Abilities</legend>
        {(card.abilities ?? []).map((ability, index) => (
          <div key={index} className="ttrpg-row">
            <input
              aria-label={`Ability ${index + 1} name`}
              placeholder="Name"
              value={ability.name}
              onChange={(e) =>
                set("abilities", (card.abilities ?? []).map((a, i) => (i === index ? { ...a, name: e.target.value } : a)))
              }
            />
            <input
              aria-label={`Ability ${index + 1} text`}
              placeholder="What it does"
              value={ability.text ?? ""}
              onChange={(e) =>
                set("abilities", (card.abilities ?? []).map((a, i) => (i === index ? { ...a, text: e.target.value } : a)))
              }
            />
            <button type="button" className="ghost" onClick={() => set("abilities", (card.abilities ?? []).filter((_, i) => i !== index))}>
              Remove ability {index + 1}
            </button>
          </div>
        ))}
        <button type="button" className="ghost" onClick={() => set("abilities", [...(card.abilities ?? []), { name: "", text: "" }])}>
          Add ability
        </button>
      </fieldset>

      <fieldset>
        <legend>Limited-use resources</legend>
        {(card.resources ?? []).map((resource, index) => (
          <div key={resource.key} className="ttrpg-row">
            <input
              aria-label={`Resource ${index + 1} name`}
              placeholder="Name"
              value={resource.name}
              onChange={(e) =>
                set("resources", (card.resources ?? []).map((r, i) => (i === index ? { ...r, name: e.target.value } : r)))
              }
            />
            <input
              aria-label={`Resource ${index + 1} uses`}
              type="number"
              min={1}
              max={99}
              value={resource.max}
              onChange={(e) =>
                set("resources", (card.resources ?? []).map((r, i) => (i === index ? { ...r, max: number(e.target.value, 1) } : r)))
              }
            />
            <select
              aria-label={`Resource ${index + 1} recovers on`}
              value={resource.reset ?? "long"}
              onChange={(e) =>
                set(
                  "resources",
                  (card.resources ?? []).map((r, i) => (i === index ? { ...r, reset: e.target.value as "short" | "long" | "none" } : r)),
                )
              }
            >
              <option value="short">Short rest</option>
              <option value="long">Long rest</option>
              <option value="none">Never</option>
            </select>
            <button type="button" className="ghost" onClick={() => set("resources", (card.resources ?? []).filter((_, i) => i !== index))}>
              Remove resource {index + 1}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="ghost"
          onClick={() => {
            const taken = new Set((card.resources ?? []).map((r) => r.key));
            set("resources", [
              ...(card.resources ?? []),
              { key: keyOf("resource", taken), name: "", max: 1, reset: "long" },
            ]);
          }}
        >
          Add resource
        </button>
      </fieldset>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="ttrpg-actions">
        <button type="submit" disabled={busy || !card.name.trim() || (card.resources ?? []).some((r) => !r.name.trim())}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
