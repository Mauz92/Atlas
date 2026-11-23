import { useEffect, useState } from "react";

import {
  notesApi,
  ttrpgApi,
  type CampaignNote,
  type NoteDetail,
  type PartyMember,
} from "../../api/client";
import { useNoteAutosave } from "../../hooks/useNoteAutosave";
import {
  newPanelId,
  readPanels,
  writePanels,
  type PanelConfig,
  type PanelKind,
} from "../../lib/sidePanels";
import { NoteEditor } from "../NoteEditor";
import { readEditorMode } from "../../lib/notesPrefs";
import { RulesBrowser } from "./RulesBrowser";

const KIND_LABEL: Record<PanelKind, string> = {
  rules: "Rules",
  note: "Note",
  party: "Party",
};

/**
 * The right-hand sidebar: tabs you add and remove. Rules is there by default; add a campaign note
 * (read or edit it beside the fight) or the party sheet, and close what you do not want. The choice
 * is remembered in this browser. `ruleRequest` (a condition tapped in a fight) brings the rules tab
 * forward, adding it first if it was closed.
 */
export function SidePanels({
  campaignId,
  ruleRequest,
  groupLevel = 2,
}: {
  campaignId: string;
  ruleRequest?: { id: string; tick: number } | null;
  groupLevel?: 2 | 3;
}) {
  const [panels, setPanels] = useState<PanelConfig[]>(readPanels);
  const [active, setActive] = useState<string | null>(
    () => readPanels()[0]?.id ?? null,
  );

  function commit(next: PanelConfig[], select?: string | null) {
    setPanels(next);
    writePanels(next);
    if (select !== undefined) setActive(select);
    else if (!next.some((panel) => panel.id === active))
      setActive(next[0]?.id ?? null);
  }

  useEffect(() => {
    if (!ruleRequest) return;
    setPanels((current) => {
      const existing = current.find((panel) => panel.kind === "rules");
      if (existing) {
        setActive(existing.id);
        return current;
      }
      const added = { id: newPanelId(), kind: "rules" as const };
      const next = [added, ...current];
      writePanels(next);
      setActive(added.id);
      return next;
    });
  }, [ruleRequest]);

  const current =
    panels.find((panel) => panel.id === active) ?? panels[0] ?? null;

  function add(kind: PanelKind) {
    const panel: PanelConfig = { id: newPanelId(), kind };
    commit([...panels, panel], panel.id);
  }

  return (
    <aside className="tt-side" aria-label="Side panels">
      <div className="tt-tabs">
        <div role="tablist" aria-label="Side panels" className="tt-tablist">
          {panels.map((panel) => (
            <button
              key={panel.id}
              type="button"
              role="tab"
              className="tt-tab"
              data-active={panel.id === current?.id}
              aria-selected={panel.id === current?.id}
              onClick={() => setActive(panel.id)}
            >
              {KIND_LABEL[panel.kind]}
            </button>
          ))}
        </div>
        {current && (
          <button
            type="button"
            className="ghost tt-close"
            aria-label={`Close the ${KIND_LABEL[current.kind].toLowerCase()} panel`}
            onClick={() => commit(panels.filter((p) => p.id !== current.id))}
          >
            ×
          </button>
        )}
        <details className="tt-add">
          <summary>+ Add panel</summary>
          <div className="menu" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                add("rules");
                (
                  e.currentTarget.closest("details") as HTMLDetailsElement
                ).open = false;
              }}
            >
              Rules reference
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                add("note");
                (
                  e.currentTarget.closest("details") as HTMLDetailsElement
                ).open = false;
              }}
            >
              A campaign note
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                add("party");
                (
                  e.currentTarget.closest("details") as HTMLDetailsElement
                ).open = false;
              }}
            >
              Party sheet
            </button>
          </div>
        </details>
      </div>
      <div className="tt-panel-body" role="tabpanel">
        {current === null && (
          <p className="tt-empty">
            Nothing here yet. Add the rules reference, a note or the party
            sheet.
          </p>
        )}
        {current?.kind === "rules" && (
          <RulesBrowser
            key={ruleRequest?.tick ?? 0}
            focusId={ruleRequest?.id ?? null}
            compact
            groupLevel={groupLevel}
          />
        )}
        {current?.kind === "party" && <PartySheet campaignId={campaignId} />}
        {current?.kind === "note" && (
          <NotePanel
            key={current.id}
            campaignId={campaignId}
            noteId={current.noteId ?? null}
            onPick={(noteId) =>
              commit(
                panels.map((p) => (p.id === current.id ? { ...p, noteId } : p)),
                current.id,
              )
            }
          />
        )}
      </div>
    </aside>
  );
}

function PartySheet({ campaignId }: { campaignId: string }) {
  const [members, setMembers] = useState<PartyMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    ttrpgApi
      .party(campaignId)
      .then((list) => !cancelled && setMembers(list.items))
      .catch(() => !cancelled && setError("Could not load the party"));
    return () => {
      cancelled = true;
    };
  }, [campaignId]);
  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (!members) return <p className="muted">Loading the party…</p>;
  if (members.length === 0)
    return <p className="tt-empty">No party members yet.</p>;
  return (
    <ul className="tt-list">
      {members.map((member) => (
        <li key={member.id} className="tt-member">
          <h3>
            {member.name}
            <span className="muted">
              {member.role === "pc" ? "PC" : "companion"}
              {member.level ? ` · level ${member.level}` : ""}
            </span>
          </h3>
          <p className="tt-stats">
            <span>
              AC <b>{member.ac}</b>
            </span>
            <span>
              HP{" "}
              <b>
                {member.state.current_hp}/{member.max_hp}
              </b>
            </span>
            {member.speed != null && (
              <span>
                Speed <b>{member.speed}</b>
              </span>
            )}
            {member.passive_perception != null && (
              <span>
                Passive Perception <b>{member.passive_perception}</b>
              </span>
            )}
            <span>
              Initiative{" "}
              <b>
                {member.initiative_mod >= 0 ? "+" : ""}
                {member.initiative_mod}
              </b>
            </span>
          </p>
          {member.attacks.map((attack) => (
            <p key={attack.name}>
              <strong>{attack.name}</strong>
              {attack.to_hit != null ? ` +${attack.to_hit} to hit` : ""}
              {attack.damage ? `, ${attack.damage}` : ""}
            </p>
          ))}
          {member.abilities.map((ability) => (
            <p key={ability.name}>
              <strong>{ability.name}.</strong> {ability.text}
            </p>
          ))}
          {member.resources.map((resource) => (
            <p key={resource.key} className="muted">
              {resource.name}:{" "}
              {resource.max - (member.state.resources_used[resource.key] ?? 0)}/
              {resource.max} left
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

function NotePanel({
  campaignId,
  noteId,
  onPick,
}: {
  campaignId: string;
  noteId: string | null;
  onPick: (noteId: string) => void;
}) {
  const [options, setOptions] = useState<CampaignNote[] | null>(null);
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    ttrpgApi
      .campaignNotes(campaignId)
      .then((list) => !cancelled && setOptions(list.items))
      .catch(() => !cancelled && setError("Could not load the notes"));
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  useEffect(() => {
    if (!noteId) {
      setNote(null);
      return;
    }
    let cancelled = false;
    setError(null);
    notesApi
      .get(noteId)
      .then((loaded) => !cancelled && setNote(loaded))
      .catch(() => {
        if (!cancelled) {
          setNote(null);
          setError(
            "That note could not be opened (it may have been deleted). Choose another.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  const { session, snapshot } = useNoteAutosave(note);
  return (
    <>
      <label>
        <span className="sr-only">Note to show</span>
        <select
          aria-label="Note to show"
          value={noteId ?? ""}
          onChange={(e) => e.target.value && onPick(e.target.value)}
        >
          <option value="">Choose a campaign note…</option>
          {(options ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label ?? option.title}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note ? (
        <NoteEditor
          key={note.id}
          value={snapshot?.content ?? note.content}
          onChange={(text) => session?.change(text)}
          mode={readEditorMode()}
        />
      ) : (
        !error && (
          <p className="tt-empty">Pick a note to read or edit it here.</p>
        )
      )}
    </>
  );
}
