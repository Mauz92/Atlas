import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, ttrpgApi, type PartyCard, type PartyMember } from "../../api/client";
import { HpBar } from "./HpBar";
import { LoadError } from "../LoadError";
import { MemberForm } from "./MemberForm";
import { RestDialog } from "./RestDialog";

function message(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 409) {
    return "Someone changed this elsewhere. It has been reloaded; try again.";
  }
  return err instanceof Error ? err.message : fallback;
}

function toCard(member: PartyMember): PartyCard {
  const { id: _id, campaign_id: _c, archived: _a, revision: _r, state: _s, ...card } = member;
  void _id; void _c; void _a; void _r; void _s;
  return card;
}

/** The party of one campaign: cards and play state, kept between fights. */
export function PartyPanel({ campaignId, archived }: { campaignId: string; archived: boolean }) {
  const [members, setMembers] = useState<PartyMember[] | null>(null);
  const [conditions, setConditions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [resting, setResting] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const newId = useRef(crypto.randomUUID());

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await ttrpgApi.party(campaignId, showArchived);
      setMembers(list.items);
      setConditions(list.conditions);
    } catch (err) {
      setError(message(err, "Could not load the party"));
    }
  }, [campaignId, showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(work: () => Promise<unknown>, failure: string): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      await load();
      return true;
    } catch (err) {
      setActionError(message(err, failure));
      await load();
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (error) return <LoadError message={error} onRetry={() => void load()} />;
  if (!members) return <p className="muted">Loading party…</p>;

  return (
    <section aria-labelledby="ttrpg-party-title" className="tt-card">
      <h2 id="ttrpg-party-title">Party</h2>
      <div className="tt-actions">
        <button type="button" disabled={busy || archived} onClick={() => setAdding(true)}>
          Add member
        </button>
        <button type="button" className="ghost" disabled={busy || members.length === 0} onClick={() => setResting(true)}>
          Rest…
        </button>
        <label className="settings-switch">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show retired
        </label>
      </div>
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}
      {adding && (
        <MemberForm
          submitLabel="Add to party"
          busy={busy}
          onCancel={() => setAdding(false)}
          onSubmit={(card) =>
            void act(() => ttrpgApi.addMember(campaignId, { ...card, id: newId.current }), "Could not add the member").then(
              (ok) => {
                if (ok) {
                  newId.current = crypto.randomUUID();
                  setAdding(false);
                }
              },
            )
          }
        />
      )}
      {members.length === 0 && !adding && (
        <p className="muted">No party members yet. Add the player characters and any companion.</p>
      )}
      <ul className="tt-party">
        {members.map((member) =>
          editing === member.id ? (
            <li key={member.id}>
              <MemberForm
                initial={toCard(member)}
                submitLabel="Save card"
                busy={busy}
                onCancel={() => setEditing(null)}
                onSubmit={(card) =>
                  void act(() => ttrpgApi.updateCard(member, card), "Could not save the card").then(
                    (ok) => ok && setEditing(null),
                  )
                }
              />
            </li>
          ) : (
            <MemberCard
              key={member.id}
              member={member}
              conditions={conditions}
              busy={busy}
              onEdit={() => setEditing(member.id)}
              act={act}
            />
          ),
        )}
      </ul>
      {resting && (
        <RestDialog
          campaignId={campaignId}
          onClose={() => setResting(false)}
          onApplied={() => {
            setResting(false);
            void load();
          }}
        />
      )}
    </section>
  );
}

function MemberCard({
  member,
  conditions,
  busy,
  onEdit,
  act,
}: {
  member: PartyMember;
  conditions: string[];
  busy: boolean;
  onEdit: () => void;
  act: (work: () => Promise<unknown>, failure: string) => Promise<boolean>;
}) {
  const state = member.state;
  const down = state.current_hp === 0;

  // played by hand: type or nudge the number; nothing is worked out for you
  const setHp = (value: number) => {
    const next = Math.max(0, Math.min(member.max_hp, value));
    if (next !== state.current_hp) void act(() => ttrpgApi.updateState(member, { current_hp: next }), "Could not change hit points");
  };
  const setTemp = (raw: string) => {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(value) || value < 0 || value === state.temp_hp) return;
    void act(() => ttrpgApi.updateState(member, { temp_hp: value }), "Could not change temporary hit points");
  };
  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };

  return (
    <li className={`tt-member${member.role === "companion" ? " companion" : ""}${member.archived ? " retired" : ""}`}>
      <h3>
        {member.name}
        <span className="muted">
          {member.role === "pc" ? "PC" : "companion"}
          {member.level ? ` · level ${member.level}` : ""}
          {member.archived ? " · retired" : ""}
        </span>
      </h3>
      <p className="tt-stats">
        <span>
          AC <b>{member.ac}</b>
        </span>
        {member.speed != null && (
          <span>
            Speed <b>{member.speed}</b>
          </span>
        )}
        <span>
          Initiative{" "}
          <b>
            {member.initiative_mod >= 0 ? "+" : ""}
            {member.initiative_mod}
          </b>
        </span>
        {member.passive_perception != null && (
          <span>
            Passive Perception <b>{member.passive_perception}</b>
          </span>
        )}
      </p>
      <HpBar name={member.name} hp={state.current_hp} max={member.max_hp} temp={state.temp_hp} />
      {!member.archived && (
        <div className="tt-controls">
          <span className="tt-hp-ctl" role="group" aria-label={`Hit points of ${member.name}`}>
            <button type="button" className="dn" disabled={busy} aria-label={`Minus 5 HP for ${member.name}`} onClick={() => setHp(state.current_hp - 5)}>
              -5
            </button>
            <button type="button" className="dn" disabled={busy} aria-label={`Minus 1 HP for ${member.name}`} onClick={() => setHp(state.current_hp - 1)}>
              -1
            </button>
            <input
              key={`hp-${state.current_hp}-${state.revision}`}
              type="number"
              min={0}
              max={member.max_hp}
              aria-label={`Current HP of ${member.name}`}
              defaultValue={state.current_hp}
              disabled={busy}
              onBlur={(e) => e.target.value.trim() !== "" && setHp(Number(e.target.value))}
              onKeyDown={onEnter}
            />
            <span className="of">/ {member.max_hp}</span>
            <button type="button" className="up" disabled={busy} aria-label={`Plus 1 HP for ${member.name}`} onClick={() => setHp(state.current_hp + 1)}>
              +1
            </button>
            <button type="button" className="up" disabled={busy} aria-label={`Plus 5 HP for ${member.name}`} onClick={() => setHp(state.current_hp + 5)}>
              +5
            </button>
          </span>
          <label>
            Temp
            <input
              key={`temp-${state.temp_hp}-${state.revision}`}
              type="number"
              min={0}
              aria-label={`Temporary HP of ${member.name}`}
              defaultValue={state.temp_hp}
              disabled={busy}
              onBlur={(e) => setTemp(e.target.value)}
              onKeyDown={onEnter}
            />
          </label>
        </div>
      )}
      {!member.archived && (
        <fieldset className="ttrpg-conditions">
          <legend>Conditions</legend>
          {conditions.map((name) => (
            <label key={name}>
              <input
                type="checkbox"
                checked={state.conditions.includes(name)}
                disabled={busy}
                onChange={(e) =>
                  void act(
                    () =>
                      ttrpgApi.updateState(member, {
                        conditions: e.target.checked
                          ? [...state.conditions, name]
                          : state.conditions.filter((c) => c !== name),
                      }),
                    "Could not change conditions",
                  )
                }
              />
              {name}
            </label>
          ))}
          <label>
            Exhaustion
            <select
              value={state.exhaustion_level}
              disabled={busy}
              onChange={(e) =>
                void act(
                  () => ttrpgApi.updateState(member, { exhaustion_level: Number(e.target.value) }),
                  "Could not change exhaustion",
                )
              }
            >
              {[0, 1, 2, 3, 4, 5, 6].map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
      )}
      {down && !member.archived && (
        <fieldset className="ttrpg-deathsaves">
          <legend>Death saves</legend>
          {(["death_save_successes", "death_save_failures"] as const).map((field) => (
            <label key={field}>
              {field === "death_save_successes" ? "Successes" : "Failures"}
              <select
                value={state[field]}
                disabled={busy}
                onChange={(e) =>
                  void act(() => ttrpgApi.updateState(member, { [field]: Number(e.target.value) }), "Could not mark death saves")
                }
              >
                {[0, 1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </fieldset>
      )}
      {member.resources.length > 0 && (
        <ul className="ttrpg-resources">
          {member.resources.map((resource) => {
            const used = state.resources_used[resource.key] ?? 0;
            return (
              <li key={resource.key}>
                {resource.name}: {resource.max - used}/{resource.max} left
                <button
                  type="button"
                  className="ghost"
                  disabled={busy || member.archived || used >= resource.max}
                  onClick={() =>
                    void act(
                      () => ttrpgApi.updateState(member, { resources_used: { ...state.resources_used, [resource.key]: used + 1 } }),
                      "Could not spend the resource",
                    )
                  }
                >
                  Spend {resource.name}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy || member.archived || used <= 0}
                  onClick={() =>
                    void act(
                      () => ttrpgApi.updateState(member, { resources_used: { ...state.resources_used, [resource.key]: used - 1 } }),
                      "Could not restore the resource",
                    )
                  }
                >
                  Restore {resource.name}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="tt-actions">
        <button type="button" className="ghost" disabled={busy} onClick={onEdit}>
          Edit card
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => void act(() => ttrpgApi.archiveMember(member, !member.archived), "Could not update the member")}
        >
          {member.archived ? "Bring back" : "Retire"}
        </button>
      </div>
    </li>
  );
}
