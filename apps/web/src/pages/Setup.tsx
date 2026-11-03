import { useState } from "react";
import type { FormEvent } from "react";

import { useAuth } from "../auth/AuthProvider";

export function Setup() {
  const { setup } = useAuth();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSubmitError(null);
    try {
      await setup(email, password, displayName);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <form className="card" onSubmit={onSubmit}>
        <h1>Create your Atlas account</h1>
        <p className="muted">This is the first account and will own this Atlas instance.</p>
        <label>
          Name
          <input
            type="text"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
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
          Password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="hint">At least 12 characters.</span>
        </label>
        {submitError ? <p className="error" role="alert">{submitError}</p> : null}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Creating…" : "Create account"}
        </button>
      </form>
    </main>
  );
}
