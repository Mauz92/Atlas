import { useState } from "react";
import type { FormEvent } from "react";

import { useAuth } from "../auth/AuthProvider";
import { ForgotPassword } from "./ForgotPassword";

export function Login() {
  const { login, error, recoveryEnabled } = useAuth();
  const [forgot, setForgot] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSubmitError(null);
    try {
      await login(email, password);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  if (forgot) {
    return <ForgotPassword enabled={recoveryEnabled} onBack={() => setForgot(false)} />;
  }

  return (
    <main className="auth-page">
      <form className="card" onSubmit={onSubmit}>
        <h1>Sign in to Atlas</h1>
        {error ? <p className="error" role="alert">{error}</p> : null}
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
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {submitError ? <p className="error" role="alert">{submitError}</p> : null}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <button type="button" className="link-button" onClick={() => setForgot(true)}>
          Forgot password?
        </button>
      </form>
    </main>
  );
}
