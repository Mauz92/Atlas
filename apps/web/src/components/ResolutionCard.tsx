import { Link } from "react-router-dom";

import type { Resolution } from "../api/client";
import { describeResolution, fieldLabel, type Names } from "../lib/syncUi/resolutionText";
import type { UndoOutcome } from "../lib/syncUi/undoOutcome";
import { Icon } from "./Icon";

interface Props {
  resolution: Resolution;
  names: Names;
  /** The entity's current title, when known (`null`: it was looked up and is gone). */
  title?: string | null;
  outcome?: UndoOutcome;
  busy?: boolean;
  /** Another undo is running; this card waits. */
  disabled?: boolean;
  onUndo: (resolution: Resolution) => void;
  now?: number;
}

/**
 * One "changed on another device" entry (SYNC-11a): what changed, on which device, when, the
 * replaced value of a simple field, and either Undo or an honest reason why there is none (with the
 * follow-up the server names). It renders what `describeResolution` returns and decides nothing.
 */
export function ResolutionCard({ resolution, names, title, outcome, busy = false, disabled = false, onUndo, now }: Props) {
  const text = describeResolution(resolution, names, now);
  const subject = title ?? (title === null ? `Deleted ${text.entity}` : `A ${text.entity}`);
  const undoName = resolution.field
    ? `Undo the change to the ${fieldLabel(resolution.field)} of ${subject}`
    : `Undo the change to ${subject}`;
  const followUp = outcome?.followUp ?? (text.undo.kind === "blocked" ? text.undo.followUp : null);

  return (
    <li className={`resolution-card${text.isUndoEntry ? " is-undo-entry" : ""}`} data-rule={resolution.rule}>
      <div className="resolution-main">
        <p className="resolution-subject">
          <Icon name={text.isUndoEntry ? "undo-2" : "arrow-left-right"} size={14} />
          {text.entityTo && title !== null ? <Link to={text.entityTo}>{subject}</Link> : <span>{subject}</span>}
          <time dateTime={resolution.created_at} title={text.whenExact} className="muted">
            {text.when}
          </time>
        </p>
        <p className="resolution-headline">{text.headline}</p>
        {text.values.length > 0 ? (
          <dl className="resolution-values">
            {text.values.map((v) => (
              <div key={v.label}>
                <dt>{v.label}</dt>
                <dd>{v.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {outcome ? (
          <p className={`resolution-outcome${outcome.safe ? "" : " is-error"}`} role={outcome.safe ? "status" : "alert"}>
            {outcome.message}
          </p>
        ) : null}
        {text.undo.kind === "blocked" && !outcome && !text.isUndoEntry ? <p className="muted resolution-reason">{text.undo.reason}</p> : null}
        {followUp?.to ? (
          <p>
            <Link to={followUp.to}>{followUp.label}</Link>
          </p>
        ) : null}
      </div>
      <div className="resolution-actions">
        {text.undo.kind === "available" ? (
          <button type="button" aria-label={undoName} disabled={busy || disabled} aria-busy={busy} onClick={() => onUndo(resolution)}>
            <Icon name="undo-2" size={14} />
            {busy ? "Undoing..." : "Undo"}
          </button>
        ) : null}
        {text.undo.kind === "undone" ? <span className="resolution-badge">Undone</span> : null}
      </div>
    </li>
  );
}
