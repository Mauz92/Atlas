import { useState } from "react";
import type { FormEvent } from "react";

import { ApiError, recoveryApi } from "../api/client";
import { RecoveryCodeReveal } from "../components/RecoveryCodeReveal";

const MIN_PASSWORD = 12;

/** The same wording whatever went wrong, so the page never says which part was not right. */
function refusal(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) {
    return "Too many attempts. Wait a few minutes and try again.";
  }
  if (err instanceof ApiError && err.status === 404) {
    return "Recovery is turned off on this server. Ask whoever runs it to reset your password.";
  }
  if (err instanceof ApiError && err.status === 422) {
    return `The new password must be at least ${MIN_PASSWORD} characters.`;
  }
  if (err instanceof ApiError && err.status === 400) {
    return "That email and recovery code do not match.";
  }
  return "Could not reach the server. Try again.";
}

interface Props {
  enabled: boolean;
  onBack: () => void;
}

/**
 * "Forgot password?" (AUTH-01, ADR-0067): email, recovery code, new password. On success every
 * session and device is signed out, the code is replaced and the new one is shown once; the owner
 * then signs in with the new password. Errors are deliberately generic.
 */
export function ForgotPassword({ enabled, onBack }: Props) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newCode, setNewCode] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const issued = await recoveryApi.reset(email, code, password);
      setNewCode(issued.recovery_code);
      setPassword("");
      setConfirm("");
      setCode("");
    } catch (err) {
      setError(refusal(err));
    } finally {
      setBusy(false);
    }
  }

  if (newCode !== null) {
    return (
      <main className="auth-page">
        <section className="card" aria-labelledby="forgot-done-title">
          <h1 id="forgot-done-title">Password changed</h1>
          <p role="status">
            Your password was changed and every browser and app was signed out. Your old recovery
            code no longer works; here is the new one.
          </p>
          <RecoveryCodeReveal
            code={newCode}
            continueLabel="Back to sign in"
            onContinue={onBack}
          />
        </section>
      </main>
    );
  }

  if (!enabled) {
    return (
      <main className="auth-page">
        <section className="card" aria-labelledby="forgot-title">
          <h1 id="forgot-title">Forgot your password?</h1>
          <p>
            Recovery by code is turned off on this server. Whoever runs it can set a new password
            for you from the server&apos;s command line (<code>atlas-admin reset-password</code>).
          </p>
          <button type="button" onClick={onBack}>
            Back to sign in
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <form className="card" onSubmit={(event) => void onSubmit(event)}>
        <h1>Forgot your password?</h1>
        <p className="muted">
          Enter your email, the recovery code you saved when you set up Atlas, and a new password.
          Changing it signs you out everywhere.
        </p>
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Recovery code
          <input
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-describedby="forgot-code-hint"
          />
          <span id="forgot-code-hint" className="hint">
            Dashes, spaces and capitals do not matter.
          </span>
        </label>
        <label>
          New password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="hint">At least {MIN_PASSWORD} characters.</span>
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Changing…" : "Change password"}
        </button>
        <button type="button" className="link-button" onClick={onBack}>
          Back to sign in
        </button>
      </form>
    </main>
  );
}
