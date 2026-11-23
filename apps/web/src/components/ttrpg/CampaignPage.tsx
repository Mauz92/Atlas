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
import { EncountersPanel } from "./EncountersPanel";
import { PartyPanel } from "./PartyPanel";

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
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TtrpgSessionDetail | null>(null);

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
  if (!campaign) return <Skeleton label="Loading campaign" rows={4} kind="line" />;

  return (
    <section className="page ttrpg-page">
      <p>
        <Link to="/ttrpg">All campaigns</Link>
      </p>
      <h1>{campaign.title}</h1>
      <p className="muted">
        {campaign.book_title ? `${campaign.book_title} · ` : ""}D&amp;D 5e (2014)
        {campaign.archived ? " · archived" : ""}
      </p>
      <dl className="settings-facts">
        <div>
          <dt>Campaign home</dt>
          <dd>
            <NoteLinkView
              link={campaign.home}
              busy={busy}
              onRecreate={() =>
                void act(() => ttrpgApi.relink(campaign.id, "home"), "Could not recreate the note")
              }
              onLinkExisting={(noteId) =>
                void act(() => ttrpgApi.relink(campaign.id, "home", noteId), "Could not link the note")
              }
            />
          </dd>
        </div>
        <div>
          <dt>Notes folder</dt>
          <dd>{campaign.folder}</dd>
        </div>
      </dl>
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}
      <div className="ttrpg-actions">
        <button
          type="button"
          disabled={busy || campaign.archived}
          onClick={() =>
            void act(
              () => ttrpgApi.addSession(campaign.id, { id: crypto.randomUUID() }),
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
              () => ttrpgApi.updateCampaign(campaign, { archived: !campaign.archived }),
              "Could not update the campaign",
            )
          }
        >
          {campaign.archived ? "Restore campaign" : "Archive campaign"}
        </button>
      </div>
      <h2>Sessions</h2>
      <ul className="ttrpg-sessions">
        {campaign.sessions.map((session) => (
          <li key={session.id} aria-current={openId === session.id ? "true" : undefined}>
            <button
              type="button"
              className="ghost"
              aria-expanded={openId === session.id}
              onClick={() => setOpenId(openId === session.id ? null : session.id)}
            >
              {session.sequence}. {session.title}
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
                        status: event.target.value as TtrpgSession["status"],
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
                  () => ttrpgApi.relink(campaign.id, session.id, noteId),
                  "Could not link the note",
                )
              }
            />
          </li>
        ))}
      </ul>
      {detail && openId === detail.id && (
        <aside className="ttrpg-handoff" aria-label="Where we left off">
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
      <PartyPanel campaignId={campaign.id} archived={campaign.archived} />
      <EncountersPanel campaign={campaign} />
    </section>
  );
}
