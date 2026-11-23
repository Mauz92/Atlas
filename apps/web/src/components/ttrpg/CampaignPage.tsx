import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  ApiError,
  ttrpgApi,
  type TtrpgCampaignDetail,
  type TtrpgSession,
  type TtrpgSessionDetail,
} from "../../api/client";
import { LoadError } from "../LoadError";
import { Skeleton } from "../Skeleton";
import { NoteLinkView } from "./NoteLinkView";
import { CampaignNotes } from "./CampaignNotes";
import { EncountersPanel } from "./EncountersPanel";
import { PartyPanel } from "./PartyPanel";
import { SidePanels } from "./SidePanels";

function message(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 409) {
    return "This changed elsewhere. It has been reloaded; try again.";
  }
  return err instanceof Error ? err.message : fallback;
}

const STATUS_LABEL: Record<TtrpgSession["status"], string> = {
  planned: "Planned",
  active: "Active",
  done: "Done",
};

/** One campaign: its home note, its sessions, and the handoff from the previous session. */
export function CampaignPage() {
  const { campaignId = "" } = useParams();
  const [campaign, setCampaign] = useState<TtrpgCampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TtrpgSessionDetail | null>(null);
  const [tab, setTab] = useState<"sessions" | "notes" | "party" | "encounters">(
    "sessions",
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      setCampaign(await ttrpgApi.campaign(campaignId));
    } catch (err) {
      setError(message(err, "Could not load the campaign"));
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!openId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    ttrpgApi
      .session(openId)
      .then((value) => !cancelled && setDetail(value))
      .catch(() => !cancelled && setDetail(null));
    return () => {
      cancelled = true;
    };
  }, [openId, campaign]);

  async function act(work: () => Promise<unknown>, failure: string) {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      await load();
    } catch (err) {
      setActionError(message(err, failure));
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (error) return <LoadError message={error} onRetry={() => void load()} />;
  if (!campaign)
    return <Skeleton label="Loading campaign" rows={4} kind="line" />;

  return (
    <section className="page">
      <p className="tt-crumb">
        <Link to="/ttrpg">All campaigns</Link>
      </p>
      <div className="tt-banner">
        <div>
          <h1>{campaign.title}</h1>
          <p className="sub">
            {campaign.book_title ? `${campaign.book_title} · ` : ""}D&amp;D 5e
            (2014)
            {campaign.archived ? " · archived" : ""}
          </p>
        </div>
        <div className="tt-actions">
          <button
            type="button"
            className="primary"
            disabled={busy || campaign.archived}
            onClick={() =>
              void act(
                () =>
                  ttrpgApi.addSession(campaign.id, { id: crypto.randomUUID() }),
                "Could not add a session",
              )
            }
          >
            New session
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() =>
              void act(
                () =>
                  ttrpgApi.updateCampaign(campaign, {
                    archived: !campaign.archived,
                  }),
                "Could not update the campaign",
              )
            }
          >
            {campaign.archived ? "Restore campaign" : "Archive campaign"}
          </button>
        </div>
      </div>
      <div className="tt-rule" aria-hidden="true" />
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
          <div className="tt-tabs">
            <div
              role="tablist"
              aria-label="Campaign sections"
              className="tt-tablist"
            >
              {(["sessions", "notes", "party", "encounters"] as const).map(
                (id) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    className="tt-tab"
                    data-active={tab === id}
                    aria-selected={tab === id}
                    onClick={() => setTab(id)}
                  >
                    {id[0].toUpperCase() + id.slice(1)}
                  </button>
                ),
              )}
            </div>
          </div>
          {tab === "sessions" && (
            <section className="tt-card" aria-labelledby="tt-sessions-title">
              <h2 id="tt-sessions-title">Sessions</h2>
              <dl className="tt-facts">
                <dt>Campaign home</dt>
                <dd>
                  <NoteLinkView
                    link={campaign.home}
                    busy={busy}
                    onRecreate={() =>
                      void act(
                        () => ttrpgApi.relink(campaign.id, "home"),
                        "Could not recreate the note",
                      )
                    }
                    onLinkExisting={(noteId) =>
                      void act(
                        () => ttrpgApi.relink(campaign.id, "home", noteId),
                        "Could not link the note",
                      )
                    }
                  />
                </dd>
                <dt>Notes folder</dt>
                <dd>{campaign.folder}</dd>
              </dl>
              <ul className="tt-list">
                {campaign.sessions.map((session) => (
                  <li
                    key={session.id}
                    className="tt-session"
                    aria-current={openId === session.id ? "true" : undefined}
                  >
                    <button
                      type="button"
                      className="ghost"
                      aria-expanded={openId === session.id}
                      onClick={() =>
                        setOpenId(openId === session.id ? null : session.id)
                      }
                    >
                      <span className="num">{session.sequence}.</span>{" "}
                      {session.title}
                    </button>
                    <label>
                      <span className="sr-only">Status of {session.title}</span>
                      <select
                        value={session.status}
                        disabled={busy}
                        onChange={(event) =>
                          void act(
                            () =>
                              ttrpgApi.updateSession(session, {
                                status: event.target
                                  .value as TtrpgSession["status"],
                              }),
                            "Could not change the status",
                          )
                        }
                      >
                        {Object.entries(STATUS_LABEL).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <NoteLinkView
                      link={session.note}
                      busy={busy}
                      onRecreate={() =>
                        void act(
                          () => ttrpgApi.relink(campaign.id, session.id),
                          "Could not recreate the note",
                        )
                      }
                      onLinkExisting={(noteId) =>
                        void act(
                          () =>
                            ttrpgApi.relink(campaign.id, session.id, noteId),
                          "Could not link the note",
                        )
                      }
                    />
                  </li>
                ))}
              </ul>
              {detail && openId === detail.id && (
                <aside className="tt-handoff" aria-label="Where we left off">
                  <h3>Where we left off</h3>
                  {detail.previous ? (
                    detail.previous.handoff ? (
                      <>
                        <p className="muted">From {detail.previous.title}</p>
                        <pre>{detail.previous.handoff}</pre>
                      </>
                    ) : (
                      <p className="muted">
                        {detail.previous.note.missing
                          ? `The note for ${detail.previous.title} is missing.`
                          : `${detail.previous.title} has no “Next session” text yet.`}
                      </p>
                    )
                  ) : (
                    <p className="muted">This is the first session.</p>
                  )}
                </aside>
              )}
            </section>
          )}
          {tab === "notes" && (
            <CampaignNotes
              campaignId={campaign.id}
              archived={campaign.archived}
              refreshKey={campaign}
            />
          )}
          {tab === "party" && (
            <PartyPanel campaignId={campaign.id} archived={campaign.archived} />
          )}
          {tab === "encounters" && <EncountersPanel campaign={campaign} />}
        </div>
        <div className="tt-card tt-side-card">
          <SidePanels campaignId={campaign.id} />
        </div>
      </div>
    </section>
  );
}
