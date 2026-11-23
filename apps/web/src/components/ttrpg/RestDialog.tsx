import { useEffect, useState } from "react";

import { ApiError, ttrpgApi, type RestPreview } from "../../api/client";

type Kind = "short" | "long";

/** Preview a short or long rest, let the DM adjust it, then apply it to the whole party at once. */
export function RestDialog({
  campaignId,
  onClose,
  onApplied,
}: {
  campaignId: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [kind, setKind] = useState<Kind>("long");
  const [preview, setPreview] = useState<RestPreview | null>(null);
  const [hp, setHp] = useState<Record<string, string>>({});
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setHp({});
    setSkip(new Set());
    ttrpgApi
      .previewRest(campaignId, kind)
      .then((value) => !cancelled && setPreview(value))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Could not preview the rest"));
    return () => {
      cancelled = true;
    };
  }, [campaignId, kind]);

  async function apply() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const members = preview.members
        .filter((member) => !skip.has(member.member_id))
        .map((member) => {
          const typed = hp[member.member_id];
          return {
            member_id: member.member_id,
            base_revision: member.state_revision,
            overrides: typed !== undefined && typed !== "" ? { current_hp: Number(typed) } : null,
          };
        });
      await ttrpgApi.applyRest(campaignId, kind, members);
      onApplied();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "The party changed since this preview. Close and reopen the rest."
          : err instanceof Error
            ? err.message
            : "Could not apply the rest",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-modal="false" aria-labelledby="ttrpg-rest-title" className="ttrpg-rest">
      <h3 id="ttrpg-rest-title">Rest</h3>
      <label>
        Kind
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="short">Short rest</option>
          <option value="long">Long rest</option>
        </select>
      </label>
      {preview?.notes.map((note) => (
        <p key={note} className="muted">
          {note}
        </p>
      ))}
      {!preview && !error && <p className="muted">Working out the changes…</p>}
      <ul>
        {preview?.members.map((member) => (
          <li key={member.member_id}>
            <label>
              <input
                type="checkbox"
                checked={!skip.has(member.member_id)}
                onChange={(e) => {
                  const next = new Set(skip);
                  if (e.target.checked) next.delete(member.member_id);
                  else next.add(member.member_id);
                  setSkip(next);
                }}
              />
              {member.name}
            </label>
            {member.unchanged ? (
              <span className="muted"> nothing to change</span>
            ) : (
              <span>
                {member.hp && ` HP ${member.hp.before} → ${member.hp.after}`}
                {member.temp_hp && ` · temp HP ${member.temp_hp.before} → ${member.temp_hp.after}`}
                {member.exhaustion_level &&
                  ` · exhaustion ${member.exhaustion_level.before} → ${member.exhaustion_level.after}`}
                {member.death_saves_cleared && " · death saves cleared"}
                {Object.entries(member.resources_used).map(
                  ([key, change]) => ` · ${key}: ${change.before} used → ${change.after}`,
                )}
              </span>
            )}
            <label>
              <span className="sr-only">Set HP for {member.name}</span>
              <input
                type="number"
                min={0}
                placeholder="HP (optional)"
                value={hp[member.member_id] ?? ""}
                onChange={(e) => setHp({ ...hp, [member.member_id]: e.target.value })}
              />
            </label>
          </li>
        ))}
      </ul>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="ttrpg-actions">
        <button type="button" disabled={busy || !preview} onClick={() => void apply()}>
          Apply rest
        </button>
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
