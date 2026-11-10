import { useState } from "react";

import type { CalendarProviderAccount, CalendarSource } from "../../api/client";
import { cardState, colorVar, setupProblemText, type CardState } from "../../lib/calendar";
import { formatLastSync, stateLabel } from "../../lib/syncStatus";
import { Icon } from "../Icon";
import { ColorPicker } from "./ColorPicker";
import { FeedForm } from "./FeedForm";
import type { CalendarAccountsResult } from "../../hooks/useCalendarAccounts";

const STATE_PILL: Record<CardState, { text: string; tone: string }> = {
  not_configured: { text: "Not configured", tone: "" },
  not_connected: { text: "Not connected", tone: "" },
  connected: { text: "Connected", tone: " pill-success" },
  needs_reauth: { text: "Needs re-authorisation", tone: " pill-warning" },
  error: { text: "Sync problem", tone: " pill-danger" },
};

function lastSync(calendars: CalendarSource[]): string | null {
  const times = calendars.map((calendar) => calendar.last_success_at).filter((value): value is string => !!value);
  if (times.length === 0) return null;
  const when = formatLastSync(times.sort().at(-1) ?? null);
  return when ? `Last synced ${when}` : null;
}

function CalendarRow({
  calendar, busy, onSelect, onColor, onRemove,
}: {
  calendar: CalendarSource;
  busy: boolean;
  onSelect: (selected: boolean) => void;
  onColor: (color: string) => void;
  onRemove?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="cal-row">
      <label className="cal-show">
        <input type="checkbox" checked={calendar.selected} disabled={busy} onChange={(event) => onSelect(event.target.checked)} />
        <span className="cal-dot" style={{ background: colorVar(calendar.color) }} aria-hidden="true" />
        <span className="cal-name">
          <span className="sr-only">Show </span>
          {calendar.name}
        </span>
      </label>
      {calendar.is_read_only && calendar.provider !== "ics" ? <span className="pill">Read only</span> : null}
      {calendar.is_primary ? <span className="pill">Primary</span> : null}
      <ColorPicker label={calendar.name} value={calendar.color} disabled={busy} onChange={onColor} />
      {calendar.feed_url_display ? <code className="cal-masked" aria-label="Feed link, masked">{calendar.feed_url_display}</code> : null}
      {calendar.state && calendar.state !== "idle" ? <span className="muted cal-state">{stateLabel(calendar.state)}</span> : null}
      {calendar.last_error ? <p className="error cal-error" role="alert">{calendar.last_error}</p> : null}
      {onRemove ? (
        confirming ? (
          <span className="cal-confirm" role="group" aria-label={`Remove ${calendar.name}`}>
            <span>Remove this feed and its stored events from Atlas? Your calendar at the source is not changed.</span>
            <button type="button" className="danger" disabled={busy} onClick={onRemove}>Remove feed</button>
            <button type="button" onClick={() => setConfirming(false)}>Keep</button>
          </span>
        ) : (
          <button type="button" className="cal-remove" onClick={() => setConfirming(true)} aria-label={`Remove feed ${calendar.name}`}>
            <Icon name="trash-2" size={16} />
            <span>Remove</span>
          </button>
        )
      ) : null}
    </li>
  );
}

interface ProviderCardProps {
  provider: CalendarProviderAccount;
  actions: CalendarAccountsResult;
  /** A message to show inside this card (the outcome of a disconnect). */
  note: string | null;
}

/**
 * One provider card (Google, Microsoft or ICS feeds): its state, the help or action that state
 * needs, and its calendars with a visibility toggle, a colour and a read-only badge.
 */
export function ProviderCard({ provider, actions, note }: ProviderCardProps) {
  const state = cardState(provider);
  const pill = STATE_PILL[state];
  const isFeed = provider.provider === "ics";
  const oauth = provider.provider as "google" | "microsoft";
  const [confirming, setConfirming] = useState(false);
  const busy = (key: string) => actions.busy === key;
  const synced = lastSync(provider.calendars);

  return (
    <li className="cal-card" data-provider={provider.provider} data-state={state}>
      <header className="cal-card-head">
        <h2>{provider.label}</h2>
        {isFeed && provider.calendars.length === 0 ? null : (
          <span className={`pill${pill.tone}`} role="status">{pill.text}</span>
        )}
      </header>

      {state === "not_configured" ? (
        <div className="cal-setup" role="note">
          <p>
            {provider.label} is not set up on this server yet, so there is no Connect button. To enable it, an
            administrator sets up the provider once:
          </p>
          <ul>
            {provider.setup_problems.map((problem) => <li key={problem}>{setupProblemText(problem)}</li>)}
          </ul>
          {provider.redirect_uri ? (
            <p>
              Register exactly this redirect URI with the provider: <code className="cal-uri">{provider.redirect_uri}</code>
            </p>
          ) : null}
          <p className="muted">Step by step: docs/CALENDAR_SYNC.md, “Setup guide”.</p>
        </div>
      ) : null}

      {state === "not_connected" && !isFeed ? (
        <>
          <p className="muted">Read-only: Atlas only reads your events and never changes your calendar.</p>
          <div className="cal-actions">
            <button type="button" disabled={busy(provider.provider)} onClick={() => void actions.connect(oauth)}>
              Connect {provider.label}
            </button>
          </div>
        </>
      ) : null}

      {state === "needs_reauth" ? (
        <>
          <p className="error" role="alert">
            {provider.label} stopped accepting the saved sign-in (it was revoked or expired). Reconnect to resume syncing;
            your stored events stay visible meanwhile.
          </p>
          <div className="cal-actions">
            <button type="button" onClick={() => void actions.connect(oauth)}>Reconnect</button>
          </div>
        </>
      ) : null}

      {provider.connected && !isFeed ? (
        <p className="muted cal-last">{synced ?? "Not synced yet"}</p>
      ) : null}
      {isFeed && provider.calendars.length > 0 ? (
        <p className="muted cal-last">
          {synced ?? "Not synced yet"} · checked about every {Math.round((provider.poll_seconds ?? 900) / 60)} minutes
        </p>
      ) : null}

      {provider.calendars.length > 0 ? (
        <ul className="cal-rows" aria-label={`${provider.label} calendars`}>
          {provider.calendars.map((calendar) => (
            <CalendarRow
              key={calendar.id}
              calendar={calendar}
              busy={busy(calendar.id)}
              onSelect={(selected) => void actions.setSelected(calendar.id, selected)}
              onColor={(color) => void actions.setColor(calendar.id, color)}
              onRemove={isFeed ? () => void actions.removeFeed(calendar.id) : undefined}
            />
          ))}
        </ul>
      ) : provider.connected && !isFeed ? (
        <p className="muted">No calendars found yet. Use “Sync now”.</p>
      ) : null}

      {provider.connected || (isFeed && provider.calendars.length > 0) ? (
        <div className="cal-actions">
          <button type="button" disabled={busy(provider.provider) || state === "needs_reauth"} aria-busy={busy(provider.provider)} onClick={() => void actions.syncNow(provider.provider)}>
            <Icon name="refresh-cw" size={16} />
            {busy(provider.provider) ? "Syncing…" : "Sync now"}
          </button>
          {!isFeed ? (
            confirming ? null : <button type="button" onClick={() => setConfirming(true)}>Disconnect</button>
          ) : null}
        </div>
      ) : null}

      {confirming && !isFeed ? (
        <div className="cal-confirm" role="group" aria-label={`Disconnect ${provider.label}`}>
          <p>
            Disconnect {provider.label}? Atlas deletes the saved sign-in, the calendar list and the events it stored from
            this account. Your calendar at {provider.label} is not changed. {provider.provider === "google" ? "Access is also revoked at Google." : "Microsoft cannot be revoked from here: remove Atlas at account.live.com/consent/Manage afterwards."} Connecting again syncs everything afresh.
          </p>
          <div className="cal-actions">
            <button type="button" className="danger" onClick={() => { setConfirming(false); void actions.disconnect(oauth); }}>
              Disconnect and delete stored events
            </button>
            <button type="button" onClick={() => setConfirming(false)}>Keep connected</button>
          </div>
        </div>
      ) : null}

      {note ? <p className="muted" role="status">{note}</p> : null}

      {isFeed ? (
        <FeedForm busy={actions.busy === "feed"} onPreview={actions.previewFeed} onAdd={actions.addFeed} />
      ) : null}
    </li>
  );
}
