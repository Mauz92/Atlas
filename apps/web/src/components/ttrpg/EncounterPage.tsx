import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  ApiError,
  ttrpgApi,
  type Creature,
  type Encounter,
  type EncounterRefresh,
  type PartyMember,
  type TtrpgCampaignDetail,
} from "../../api/client";
import { LoadError } from "../LoadError";
import { Skeleton } from "../Skeleton";
import { NoteLinkView } from "./NoteLinkView";
import { SidePanels } from "./SidePanels";

function message(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 409) {
    return "This was changed elsewhere. It has been reloaded; try again.";
  }
  return err instanceof Error ? err.message : fallback;
}

const OUTCOME: Record<string, string> = {
  refreshed: "updated from its card",
  unchanged: "already current",
  no_card: "has no card to refresh from",
  card_archived: "its card is archived, kept as prepared",
};

/** One prepared encounter: reference, party, lineup of slots, and its launch link. */
export function EncounterPage() {
  const { encounterId = "" } = useParams();
  const navigate = useNavigate();
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [campaign, setCampaign] = useState<TtrpgCampaignDetail | null>(null);
  const [party, setParty] = useState<PartyMember[]>([]);
  const [creatures, setCreatures] = useState<Creature[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [report, setReport] = useState<EncounterRefresh["slots"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const loaded = await ttrpgApi.encounter(encounterId);
      setEncounter(loaded);
      const [camp, members, cards] = await Promise.all([
        ttrpgApi.campaign(loaded.campaign_id),
        ttrpgApi.party(loaded.campaign_id),
        ttrpgApi.creatures(),
      ]);
      setCampaign(camp);
      setParty(members.items);
      setCreatures(cards.items);
    } catch (err) {
      setError(message(err, "Could not load the encounter"));
    }
  }, [encounterId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(
    work: () => Promise<unknown>,
    failure: string,
  ): Promise<boolean> {
    setBusy(true);
    setActionError(null);
    setNotice(null);
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
  if (!encounter || !campaign)
    return <Skeleton label="Loading encounter" rows={4} kind="line" />;

  const chosen = new Set(encounter.party.map((member) => member.id));
  const enemies = encounter.slots.filter((slot) => slot.side !== "ally");
  const allies = encounter.slots.filter((slot) => slot.side === "ally");
  const enemyHp = enemies.reduce((sum, slot) => sum + slot.hp, 0);

  function launch() {
    void act(async () => {
      try {
        const run = await ttrpgApi.createRun(encounter!.campaign_id, {
          id: crypto.randomUUID(),
          encounter_id: encounter!.id,
        });
        navigate(`/ttrpg/runs/${run.id}`);
      } catch (err) {
        // a fight is already unfinished: go back to it rather than starting a second one
        const detail = (err as ApiError).body as
          { detail?: { code?: string; run_id?: string } } | undefined;
        if (
          err instanceof ApiError &&
          detail?.detail?.code === "run_exists" &&
          detail.detail.run_id
        ) {
          navigate(`/ttrpg/runs/${detail.detail.run_id}`);
          return;
        }
        throw err;
      }
    }, "Could not launch the encounter");
  }

  return (
    <section className="page">
      <p className="tt-crumb">
        <Link to={`/ttrpg/${campaign.id}`}>{campaign.title}</Link>
      </p>
      <div className="tt-banner">
        <div>
          <h1>{encounter.title}</h1>
          <p className="sub">
            {encounter.slots.length === 0
              ? "No combatants yet"
              : `${enemies.length} enem${enemies.length === 1 ? "y" : "ies"}${
                  allies.length
                    ? `, ${allies.length} all${allies.length === 1 ? "y" : "ies"}`
                    : ""
                } · ${enemyHp} enemy HP in total · ${chosen.size} in the party`}
            {encounter.book_reference ? ` · ${encounter.book_reference}` : ""}
          </p>
        </div>
        <div className="tt-actions">
          {encounter.slots.length === 0 && (
            <span className="muted">Add a combatant to launch</span>
          )}
          <button
            type="button"
            className="primary"
            disabled={busy || encounter.slots.length === 0}
            onClick={launch}
          >
            Launch encounter
          </button>
        </div>
      </div>
      <div className="tt-rule" aria-hidden="true" />
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}
      <button
        type="button"
        className="tt-side-toggle ghost"
        aria-expanded={sideOpen}
        onClick={() => setSideOpen(!sideOpen)}
      >
        {sideOpen ? "Hide rules and notes" : "Rules and notes"}
      </button>
      <div className="tt-layout" data-side={sideOpen ? "open" : "closed"}>
        <div className="tt-main">
          <section className="tt-card tt-fit" aria-labelledby="tt-lineup">
            <div className="tt-banner">
              <h2 id="tt-lineup">Lineup</h2>
              <button
                type="button"
                className="ghost"
                title="Re-copy AC and HP from the creature library for rows you have not edited by hand"
                disabled={busy || encounter.slots.length === 0}
                onClick={() =>
                  void act(async () => {
                    const result = await ttrpgApi.refreshEncounter(encounter);
                    setReport(result.slots);
                  }, "Could not refresh from the cards")
                }
              >
                Refresh from creature cards
              </button>
            </div>
            {encounter.slots.length === 0 ? (
              <p className="tt-empty">
                Nothing here yet. Pick a creature below, or add a custom entry.
              </p>
            ) : (
              <ul className="tt-slots">
                {encounter.slots.map((slot) => (
                  <SlotRow
                    key={slot.id}
                    slot={slot}
                    encounter={encounter}
                    busy={busy}
                    act={act}
                  />
                ))}
              </ul>
            )}
            {report && (
              <ul aria-label="Refresh result" className="muted">
                {report.map((entry) => (
                  <li key={entry.slot_id}>
                    {entry.name}: {OUTCOME[entry.outcome] ?? entry.outcome}
                  </li>
                ))}
              </ul>
            )}
            <AddSlots
              encounter={encounter}
              creatures={creatures}
              busy={busy}
              act={act}
            />
          </section>

          <div className="tt-pair">
            <section className="tt-card" aria-labelledby="tt-party-pick">
              <h2 id="tt-party-pick">Party in this encounter</h2>
              {party.length === 0 && (
                <p className="muted">Add party members first.</p>
              )}
              <div className="tt-pick">
                {party.map((member) => (
                  <label
                    key={member.id}
                    className={chosen.has(member.id) ? "on" : ""}
                  >
                    <input
                      type="checkbox"
                      checked={chosen.has(member.id)}
                      disabled={busy}
                      onChange={(e) =>
                        void act(
                          () =>
                            ttrpgApi.updateEncounter(encounter, {
                              party_member_ids: e.target.checked
                                ? [...chosen, member.id]
                                : [...chosen].filter((id) => id !== member.id),
                            }),
                          "Could not change the party",
                        )
                      }
                    />
                    {member.name}
                  </label>
                ))}
                {encounter.party
                  .filter((member) => member.retired)
                  .map((member) => (
                    <span key={member.id} className="muted">
                      {member.name} (retired)
                    </span>
                  ))}
              </div>
            </section>

            <details className="tt-card tt-details" open>
              <summary>
                <h2>Prep details</h2>
              </summary>
              <dl className="tt-facts">
                <div>
                  <dt>Book reference</dt>
                  <dd>
                    <ReferenceField
                      label="Book reference"
                      value={encounter.book_reference ?? ""}
                      busy={busy}
                      onSave={(value) =>
                        void act(
                          () =>
                            ttrpgApi.updateEncounter(encounter, {
                              book_reference: value || null,
                            }),
                          "Could not save the book reference",
                        )
                      }
                    />
                  </dd>
                </div>
                <div>
                  <dt>Setup reminder</dt>
                  <dd>
                    <ReferenceField
                      label="Setup reminder"
                      value={encounter.setup_reminder ?? ""}
                      busy={busy}
                      onSave={(value) =>
                        void act(
                          () =>
                            ttrpgApi.updateEncounter(encounter, {
                              setup_reminder: value || null,
                            }),
                          "Could not save the reminder",
                        )
                      }
                    />
                  </dd>
                </div>
                <div>
                  <dt>Session</dt>
                  <dd>
                    <select
                      aria-label="Session"
                      value={encounter.session_id ?? ""}
                      disabled={busy}
                      onChange={(e) =>
                        void act(
                          () =>
                            ttrpgApi.updateEncounter(encounter, {
                              session_id: e.target.value || null,
                            }),
                          "Could not change the session",
                        )
                      }
                    >
                      <option value="">None</option>
                      {campaign.sessions.map((session) => (
                        <option key={session.id} value={session.id}>
                          {session.sequence}. {session.title}
                        </option>
                      ))}
                    </select>
                  </dd>
                </div>
                {encounter.location && (
                  <div>
                    <dt>Location note</dt>
                    <dd>
                      <NoteLinkView link={encounter.location} />
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Launch link</dt>
                  <dd>
                    <code>{encounter.link}</code>{" "}
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy || !encounter.session_id}
                      onClick={() =>
                        void act(async () => {
                          const result = await ttrpgApi.linkEncounterToNote(
                            encounter.id,
                          );
                          setNotice(
                            result.changed
                              ? "Link added under Prep in the session note."
                              : "The session note already has this link.",
                          );
                        }, "Could not add the link to the session note")
                      }
                    >
                      Add to session note
                    </button>
                    {!encounter.session_id && (
                      <span className="muted"> Choose a session first.</span>
                    )}
                  </dd>
                </div>
              </dl>
            </details>
          </div>
        </div>
        <div className="tt-card tt-side-card">
          <SidePanels campaignId={campaign.id} />
        </div>
      </div>
    </section>
  );
}

type Act = (work: () => Promise<unknown>, failure: string) => Promise<boolean>;

function ReferenceField({
  label,
  value,
  busy,
  onSave,
}: {
  label: string;
  value: string;
  busy: boolean;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <span className="tt-row">
      <input
        aria-label={label}
        value={draft}
        maxLength={300}
        onChange={(e) => setDraft(e.target.value)}
      />
      {draft !== value && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onSave(draft.trim())}
        >
          Save {label.toLowerCase()}
        </button>
      )}
    </span>
  );
}

function SlotRow({
  slot,
  encounter,
  busy,
  act,
}: {
  slot: Encounter["slots"][number];
  encounter: Encounter;
  busy: boolean;
  act: Act;
}) {
  const [name, setName] = useState(slot.name);
  const [ac, setAc] = useState(String(slot.ac));
  const [hp, setHp] = useState(String(slot.hp));
  useEffect(() => {
    setName(slot.name);
    setAc(String(slot.ac));
    setHp(String(slot.hp));
  }, [slot]);
  const dirty =
    name !== slot.name || ac !== String(slot.ac) || hp !== String(slot.hp);
  return (
    <li className={`tt-slot${slot.side === "ally" ? " ally" : ""}`}>
      <div className="tt-slot-id">
        <input
          className="tt-slot-name"
          aria-label={`Name of ${slot.name}`}
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
        <span className="tt-slot-sub">
          <span className="tt-kind">
            {slot.side === "ally" ? "Ally" : "Enemy"}
          </span>
          {slot.overrides.length > 0 && (
            <span className="muted">
              edited here: {slot.overrides.join(", ")}
            </span>
          )}
        </span>
      </div>
      <label className="tt-num">
        AC
        <input
          aria-label={`AC of ${slot.name}`}
          type="number"
          min={0}
          max={40}
          value={ac}
          onChange={(e) => setAc(e.target.value)}
        />
      </label>
      <label className="tt-num">
        HP
        <input
          aria-label={`HP of ${slot.name}`}
          type="number"
          min={1}
          max={9999}
          value={hp}
          onChange={(e) => setHp(e.target.value)}
        />
      </label>
      <span className="tt-slot-actions">
        {dirty && (
          <button
            type="button"
            className="primary"
            aria-label={`Save ${slot.name}`}
            disabled={busy || !name.trim()}
            onClick={() =>
              void act(
                () =>
                  // only what was actually changed: every field sent counts as set by hand
                  ttrpgApi.updateSlot(encounter, slot.id, {
                    ...(name.trim() !== slot.name ? { name: name.trim() } : {}),
                    ...(ac !== String(slot.ac) ? { ac: Number(ac) } : {}),
                    ...(hp !== String(slot.hp) ? { hp: Number(hp) } : {}),
                  }),
                "Could not save the slot",
              )
            }
          >
            Save
          </button>
        )}
        <button
          type="button"
          className="ghost"
          title="Remove from the encounter"
          aria-label={`Remove ${slot.name}`}
          disabled={busy}
          onClick={() =>
            void act(
              () => ttrpgApi.removeSlot(encounter, slot.id),
              "Could not remove the slot",
            )
          }
        >
          ×
        </button>
      </span>
    </li>
  );
}

function AddSlots({
  encounter,
  creatures,
  busy,
  act,
}: {
  encounter: Encounter;
  creatures: Creature[];
  busy: boolean;
  act: Act;
}) {
  const [creatureId, setCreatureId] = useState("");
  const [count, setCount] = useState("1");
  const [side, setSide] = useState<"enemy" | "ally">("enemy");
  const [custom, setCustom] = useState({ name: "", ac: "10", hp: "10" });
  const number = Number(count);
  const validCount = Number.isInteger(number) && number >= 1 && number <= 60;
  return (
    <section aria-labelledby="ttrpg-add-slots" className="tt-add-slots">
      <h3 id="ttrpg-add-slots" className="sr-only">
        Add combatants
      </h3>
      <div className="tt-row">
        <label className="tt-grow">
          <span className="sr-only">Creature</span>
          <select
            value={creatureId}
            onChange={(e) => setCreatureId(e.target.value)}
          >
            <option value="">Choose a creature…</option>
            {creatures.map((card) => (
              <option key={card.id} value={card.id}>
                {card.name} (AC {card.ac}, HP {card.hp})
              </option>
            ))}
          </select>
        </label>
        <label className="tt-count">
          <span className="sr-only">How many</span>
          <input
            type="number"
            min={1}
            max={60}
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        </label>
        <label>
          <span className="sr-only">Side</span>
          <select
            value={side}
            onChange={(e) => setSide(e.target.value as "enemy" | "ally")}
          >
            <option value="enemy">Enemy</option>
            <option value="ally">Ally</option>
          </select>
        </label>
        <button
          type="button"
          disabled={busy || !creatureId || !validCount}
          onClick={() =>
            void act(
              () =>
                ttrpgApi.addSlots(encounter, {
                  creature_id: creatureId,
                  count: number,
                  side,
                }),
              "Could not add the creatures",
            )
          }
        >
          Add to lineup
        </button>
      </div>
      {creatures.length === 0 && (
        <p className="muted">
          No creature cards yet.{" "}
          <Link to="/ttrpg/creatures">Open the creature library</Link> to add or
          import some.
        </p>
      )}
      <details className="tt-custom">
        <summary>Custom entry</summary>
        <div className="tt-row">
          <label>
            Custom name
            <input
              value={custom.name}
              maxLength={120}
              onChange={(e) => setCustom({ ...custom, name: e.target.value })}
            />
          </label>
          <label>
            Custom AC
            <input
              type="number"
              min={0}
              max={40}
              value={custom.ac}
              onChange={(e) => setCustom({ ...custom, ac: e.target.value })}
            />
          </label>
          <label>
            Custom HP
            <input
              type="number"
              min={1}
              max={9999}
              value={custom.hp}
              onChange={(e) => setCustom({ ...custom, hp: e.target.value })}
            />
          </label>
          <button
            type="button"
            disabled={busy || !custom.name.trim()}
            onClick={() =>
              void act(
                () =>
                  ttrpgApi.addSlots(encounter, {
                    name: custom.name.trim(),
                    ac: Number(custom.ac),
                    hp: Number(custom.hp),
                    side,
                  }),
                "Could not add the entry",
              ).then((ok) => ok && setCustom({ name: "", ac: "10", hp: "10" }))
            }
          >
            Add custom entry
          </button>
        </div>
      </details>
    </section>
  );
}
