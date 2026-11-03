import { useState } from "react";
import type { FormEvent } from "react";

import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { errorMessage } from "../../lib/settingsFormat";
import { SettingsRow } from "./SettingsRow";

const MIN_PASSWORD = 12;

type FormState = { kind: "idle" | "saving" | "saved" | "error"; text?: string };

/** Display name and password. Both forms keep their MU-08 behaviour; only the layout is new. */
export function AccountSection() {
  const { user, updateDisplayName } = useAuth();
  const [name, setName] = useState(user?.display_name ?? "");
  const [nameState, setNameState] = useState<FormState>({ kind: "idle" });

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [passwordState, setPasswordState] = useState<FormState>({ kind: "idle" });

  async function saveName(event: FormEvent) {
    event.preventDefault();
    setNameState({ kind: "saving" });
    try {
      await updateDisplayName(name);
      setNameState({ kind: "saved" });
    } catch (err) {
      setNameState({ kind: "error", text: errorMessage(err, "Could not save the name") });
    }
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault();
    if (next !== confirm) {
      setPasswordState({ kind: "error", text: "The new passwords do not match" });
      return;
    }
    setPasswordState({ kind: "saving" });
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setPasswordState({ kind: "saved" });
    } catch (err) {
      setPasswordState({ kind: "error", text: errorMessage(err, "Could not change the password") });
    }
  }

  return (
    <>
      <p className="muted">Signed in as {user?.email}.</p>

      <form className="settings-group" onSubmit={(event) => void saveName(event)}>
        <SettingsRow label="Display name" htmlFor="settings-name" description="Shown in the sidebar.">
          <input
            id="settings-name"
            type="text"
            autoComplete="name"
            maxLength={120}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameState({ kind: "idle" });
            }}
          />
          <button type="submit" disabled={nameState.kind === "saving"}>
            Save name
          </button>
        </SettingsRow>
        {nameState.kind === "saved" || nameState.kind === "error" ? (
          <div className="settings-feedback">
            {nameState.kind === "saved" ? <span role="status">Name saved</span> : null}
            {nameState.kind === "error" ? (
              <p className="error" role="alert">
                {nameState.text}
              </p>
            ) : null}
          </div>
        ) : null}
      </form>

      <form className="settings-group" onSubmit={(event) => void savePassword(event)}>
        <h3>Change password</h3>
        <SettingsRow label="Current password" htmlFor="settings-current-password">
          <input
            id="settings-current-password"
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </SettingsRow>
        <SettingsRow
          label="New password"
          htmlFor="settings-new-password"
          description={`At least ${MIN_PASSWORD} characters. Changing it signs you out on your other devices.`}
          descriptionId="settings-password-hint"
        >
          <input
            id="settings-new-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD}
            aria-describedby="settings-password-hint"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
        </SettingsRow>
        <SettingsRow label="Confirm new password" htmlFor="settings-confirm-password">
          <input
            id="settings-confirm-password"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </SettingsRow>
        <div className="settings-feedback settings-submit">
          <button type="submit" disabled={passwordState.kind === "saving"}>
            Change password
          </button>
          {passwordState.kind === "saved" ? (
            <span role="status">Password changed. Other devices were signed out.</span>
          ) : null}
          {passwordState.kind === "error" ? (
            <p className="error" role="alert">
              {passwordState.text}
            </p>
          ) : null}
        </div>
      </form>
    </>
  );
}
