import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  ApiError,
  notesApi,
  ttrpgApi,
  type NoteDetail,
  type Run,
  type RunActionBody,
  type RunActionResult,
} from "../../api/client";
import { useNoteAutosave } from "../../hooks/useNoteAutosave";
import { readEditorMode } from "../../lib/notesPrefs";
import { LoadError } from "../LoadError";
import { NoteEditor } from "../NoteEditor";
import { RulesBrowser } from "./RulesBrowser";
import { Skeleton } from "../Skeleton";
import { CombatantRow } from "./CombatantRow";
import { SetupPanel } from "./SetupPanel";
import { POLL_MS, inOrder, standing, withPartyRevisions } from "./runModel";

function describe(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const detail = (err.body as { detail?: { code?: string; message?: string } } | undefined)?.detail;
    if (detail?.code === "undo_conflict") return detail.message ?? "This can no longer be undone.";
    if (err.status === 409) {
      return "The fight changed elsewhere (another tab or the party panel). It has been reloaded; look and try again.";
    }
    return err.message || fallback;
  }
  return err instanceof Error ? err.message : fallback;
}

type Pending = { body: RunActionBody; key: string; failure: string } | { undo: true; key: string; failure: string };

/**
 * Running a fight (TTRPG-06): the session note and the tracker side by side on a wide screen, and a
 * Notes/Combat switch on a narrow one. Both panes stay mounted, so switching never loses what was
 * being typed. Every change carries a mutation key; after a failure the same change can be retried
 * and a change that actually went through is not applied twice.
 */
export function RunPage() {
  const { runId = "" } = useParams();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"notes" | "combat" | "rules">("combat");
  const [ruleId, setRuleId] = useState<string | null>(null);
  // a new object each time, so reading the same rule twice still scrolls to it
  const [ruleTick, setRuleTick] = useState(0);
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [campaignTitle, setCampaignTitle] = useState("");
  const [outcome, setOutcome] = useState("");
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const loaded = await ttrpgApi.run(runId);
      if (alive.current) setRun(loaded);
      setError(null);
      return loaded;
    } catch (err) {
      if (alive.current) setError(describe(err, "Could not load the fight"));
      return null;
    }
  }, [runId]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  // The session note, shown beside the tracker.
  const sessionId = run?.session_id ?? null;
  const campaignId = run?.campaign_id ?? null;
  useEffect(() => {
    if (!campaignId) return;
    let cancelled = false;
    void (async () => {
      try {
        const campaign = await ttrpgApi.campaign(campaignId);
        if (cancelled) return;
        setCampaignTitle(campaign.title);
        const session = campaign.sessions.find((s) => s.id === sessionId);
        setSessionTitle(session?.title ?? null);
        const noteId = session && !session.note.missing ? session.note.note_id : null;
        setNote(noteId ? await notesApi.get(noteId) : null);
      } catch {
        if (!cancelled) setNote(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId, sessionId]);
  const { session: noteSession, snapshot } = useNoteAutosave(note);

  // Another tab or device may change the fight. Atlas has no push channel, so while this screen is
  // visible and idle it looks again every few seconds and shows the newer revision. A change made
  // from a stale screen is still refused by the server; this just keeps the screen current.
  const idle = !busy && !pending;
  const runRevision = run?.revision ?? null;
  const runStatus = run?.status ?? null;
  useEffect(() => {
    if (!idle || runRevision === null || runStatus === "ended") return undefined;
    let stopped = false;
    const look = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const fresh = await ttrpgApi.run(runId);
        if (!stopped && alive.current) setRun((current) => (current && fresh.revision === current.revision ? current : fresh));
      } catch {
        // keep what is on screen; the next look or the next action reports a real problem
      }
    };
    const timer = window.setInterval(() => void look(), POLL_MS);
    const onVisible = () => void look();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [idle, runRevision, runStatus, runId]);

  const settle = useCallback(
    async (work: () => Promise<Run | RunActionResult | void>, label: string): Promise<boolean> => {
      setBusy(true);
      setFailure(null);
      try {
        const result = await work();
        if (result && "run" in result) setRun(result.run);
        else if (result) setRun(result);
        setPending(null);
        return true;
      } catch (err) {
        setFailure(`${label}: ${describe(err, "something went wrong")}`);
        // A conflict means the screen was out of date: show the current fight, drop the stale change.
        if (err instanceof ApiError && err.status === 409) {
          setPending(null);
          await load();
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const act = useCallback(
    async (body: RunActionBody, label: string): Promise<boolean> => {
      if (!run) return false;
      const key = crypto.randomUUID();
      const sent = withPartyRevisions(run, body);
      setPending({ body: sent, key, failure: label });
      return settle(() => ttrpgApi.runAction(run, sent, key), label);
    },
    [run, settle],
  );

  const retry = useCallback(async () => {
    if (!run || !pending) return;
    if ("undo" in pending) {
      await settle(() => ttrpgApi.undoRun(run, pending.key), pending.failure);
    } else {
      await settle(() => ttrpgApi.runAction(run, pending.body, pending.key), pending.failure);
    }
  }, [run, pending, settle]);

  const perform = useCallback(
    (work: () => Promise<Run | void>, label: string) => settle(work, label),
    [settle],
  );

  if (error && !run) return <LoadError message={error} onRetry={() => void load()} />;
  if (!run) return <Skeleton label="Loading the fight" rows={5} kind="line" />;

  const rows = inOrder(run);
  const fighting = run.status === "active" || run.status === "paused";

  return (
    <section className="page ttrpg-page ttrpg-play" data-view={view}>
      <p>
        <Link to={`/ttrpg/${run.campaign_id}`}>{campaignTitle || "Campaign"}</Link>
        {run.encounter_id && (
          <>
            {" · "}
            <Link to={`/ttrpg/encounters/${run.encounter_id}`}>Encounter prep</Link>
          </>
        )}
      </p>
      <h1>{run.title}</h1>
      <p role="status" className="ttrpg-standing">
        {standing(run)}
      </p>
      {run.book_reference && <p className="muted">Book: {run.book_reference}</p>}
      {run.setup_reminder && run.status === "setup" && <p className="muted">Setup: {run.setup_reminder}</p>}

      <div className="ttrpg-play-switch" role="group" aria-label="Show">
        <button type="button" aria-pressed={view === "notes"} onClick={() => setView("notes")}>
          Notes
        </button>
        <button type="button" aria-pressed={view === "combat"} onClick={() => setView("combat")}>
          Combat
        </button>
        <button type="button" aria-pressed={view === "rules"} onClick={() => setView("rules")}>
          Rules
        </button>
      </div>

      <div className="ttrpg-play-panes">
        <div className="ttrpg-play-notes" data-pane="notes">
          <h2>{sessionTitle ? `${sessionTitle} notes` : "Session notes"}</h2>
          {note ? (
            <NoteEditor
              key={note.id}
              value={snapshot?.content ?? note.content}
              onChange={(text) => noteSession?.change(text)}
              mode={readEditorMode()}
            />
          ) : (
            <p className="muted">No session note is linked to this fight.</p>
          )}
        </div>

        <div className="ttrpg-play-combat" data-pane="combat">
          {failure && (
            <div className="error" role="alert">
              <p>{failure}</p>
              {pending && (
                <button type="button" onClick={() => void retry()} disabled={busy}>
                  Retry
                </button>
              )}
            </div>
          )}

          {run.status === "setup" && <SetupPanel run={run} busy={busy} perform={perform} />}

          {fighting && (
            <div className="ttrpg-actions">
              <button
                type="button"
                disabled={busy || run.status !== "active"}
                onClick={() => void act({ kind: "next_turn" }, "Could not move to the next turn")}
              >
                Next turn
              </button>
              <button
                type="button"
                className="ghost"
                disabled={busy || !run.undo_summary || run.status === "ended"}
                onClick={() => {
                  const key = crypto.randomUUID();
                  setPending({ undo: true, key, failure: "Could not undo" });
                  void settle(() => ttrpgApi.undoRun(run, key), "Could not undo");
                }}
              >
                Undo{run.undo_summary ? `: ${run.undo_summary}` : ""}
              </button>
              {run.status === "active" ? (
                <button type="button" className="ghost" disabled={busy} onClick={() => void act({ kind: "pause" }, "Could not pause")}>
                  Pause
                </button>
              ) : (
                <button type="button" disabled={busy} onClick={() => void act({ kind: "resume" }, "Could not resume")}>
                  Resume
                </button>
              )}
            </div>
          )}
          {fighting && (
            <form
              className="ttrpg-row"
              onSubmit={(e) => {
                e.preventDefault();
                void act({ kind: "end", outcome: outcome.trim() || undefined }, "Could not end the fight");
              }}
            >
              <label>
                How did it end? (optional)
                <input value={outcome} maxLength={2000} onChange={(e) => setOutcome(e.target.value)} />
              </label>
              <button type="submit" className="ghost" disabled={busy}>
                End the fight
              </button>
            </form>
          )}
          {run.status === "setup" && (
            <button type="button" className="ghost" disabled={busy} onClick={() => void act({ kind: "end" }, "Could not cancel")}>
              Cancel this fight
            </button>
          )}

          {run.status !== "setup" && (
            <ul className="ttrpg-combatants">
              {rows.map((c) => (
                <CombatantRow
                  key={c.id}
                  run={run}
                  combatant={c}
                  busy={busy}
                  act={act}
                  onRule={(id) => {
                    setRuleId(id);
                    setRuleTick((n) => n + 1);
                    setView((current) => (window.matchMedia?.("(max-width: 1100px)").matches ? "rules" : current));
                  }}
                />
              ))}
            </ul>
          )}

          <h2>History</h2>
          <ol className="ttrpg-history" reversed>
            {run.history.map((entry) => (
              <li key={entry.seq} className={entry.undone ? "muted" : undefined}>
                {entry.summary}
                {entry.undone ? " (undone)" : ""}
              </li>
            ))}
          </ol>
        </div>

        <div className="ttrpg-play-rules" data-pane="rules">
          <h2>Rules</h2>
          <RulesBrowser key={ruleTick} focusId={ruleId} compact groupLevel={3} />
        </div>
      </div>
    </section>
  );
}
