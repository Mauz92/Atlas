import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { ApiError, recoveryApi, type RecoveryStatus } from "../../api/client";
import { errorMessage } from "../../lib/settingsFormat";
import { RecoveryCodeReveal } from "../RecoveryCodeReveal";
import { SettingsRow } from "./SettingsRow";

type Load = { kind: "loading" } | { kind: "error"; text: string } | { kind: "ready"; status: RecoveryStatus };

function describe(status: RecoveryStatus): string {
  if (!status.enabled) return "Turned off by whoever runs this server.";
  if (!status.configured) return "Not set. Create one so you can recover your account.";
  const made = new Date(status.created_at ?? "").toLocaleDateString();
  const used = status.last_used_at
    ? ` Last used ${new Date(status.last_used_at).toLocaleDateString()}.`
    : "";
  const failed =
    status.failed_attempts > 0
      ? ` ${status.failed_attempts} wrong ${status.failed_attempts === 1 ? "try" : "tries"} since.`
      : "";
  return `Set on ${made}.${used}${failed}`;
}

/**
 * Settings → Account → Recovery code (AUTH-01, ADR-0067): status, and "Regenerate" which asks for
 * the current password, replaces the code and shows the new one once. The code is held in this
 * component's state only until the owner confirms having saved it.
 */
export function RecoverySection() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<string | null>(null);

  async function refresh() {
    try {
      setLoad({ kind: "ready", status: await recoveryApi.status() });
    } catch (err) {
      setLoad({ kind: "error", text: errorMessage(err, "Could not load the recovery code status") });
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function regenerate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await recoveryApi.regenerate(password);
      setIssued(result.recovery_code);
      setAsking(false);
      setPassword("");
      await refresh();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : errorMessage(err, "Could not create a recovery code"),
      );
    } finally {
      setBusy(false);
    }
  }

  const status = load.kind === "ready" ? load.status : null;
  const label = status?.configured ? "Regenerate" : "Create recovery code";

  return (
    <section className="settings-group" aria-labelledby="settings-recovery-title">
      <h3 id="settings-recovery-title">Recovery code</h3>
      {issued !== null ? (
        <div className="recovery-panel">
          <p role="status">
            Your new recovery code is ready. Any earlier code no longer works.
          </p>
          <RecoveryCodeReveal code={issued} continueLabel="Done" onContinue={() => setIssued(null)} />
        </div>
      ) : (
        <>
          <SettingsRow
            label="Recovery code"
            labelId="settings-recovery-label"
            description={
              load.kind === "loading"
                ? "Loading…"
                : load.kind === "error"
                  ? null
                  : describe(load.status)
            }
            descriptionId="settings-recovery-hint"
          >
            {status?.enabled && !asking ? (
              <button
                type="button"
                aria-describedby="settings-recovery-hint"
                onClick={() => {
                  setAsking(true);
                  setError(null);
                }}
              >
                {label}
              </button>
            ) : null}
          </SettingsRow>
          {load.kind === "error" ? (
            <p className="error" role="alert">
              {load.text}
            </p>
          ) : null}
          {asking ? (
            <form onSubmit={(event) => void regenerate(event)}>
              <SettingsRow
                label="Your password"
                htmlFor="settings-recovery-password"
                description="Needed to make a new code. The old code stops working at once."
                descriptionId="settings-recovery-password-hint"
              >
                <input
                  id="settings-recovery-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  autoFocus
                  aria-describedby="settings-recovery-password-hint"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </SettingsRow>
              <div className="settings-feedback settings-submit">
                <button type="submit" className="primary" disabled={busy}>
                  {status?.configured ? "Make a new code" : "Make a code"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAsking(false);
                    setPassword("");
                    setError(null);
                  }}
                >
                  Cancel
                </button>
                {error ? (
                  <p className="error" role="alert">
                    {error}
                  </p>
                ) : null}
              </div>
            </form>
          ) : null}
        </>
      )}
    </section>
  );
}
