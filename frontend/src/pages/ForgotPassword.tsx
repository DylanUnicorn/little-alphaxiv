// Forgot-password page: submit username or email. The backend ALWAYS returns a
// generic success (anti-enumeration), so we show the same message regardless of
// whether the identifier matched an account.

import { useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../lib/api";

export default function ForgotPassword() {
  const [identifier, setIdentifier] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!identifier.trim()) return;
    setBusy(true);
    try {
      await api.requestPasswordReset(identifier.trim());
      setDone(true);
    } catch {
      // Backend still returns 200 on a bad identifier; show generic success.
      setDone(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="main-pane login-pane">
      <form className="login-card" onSubmit={submit}>
        <h1>Reset password</h1>
        <p className="login-sub">Enter your username or email.</p>
        {done ? (
          <p className="login-hint">
            If an account with that identifier exists, a reset link is on its
            way. Check your email (or the server terminal, if no SMTP is
            configured).
          </p>
        ) : (
          <>
            <label className="login-field">
              <span>Username or email</span>
              <input
                type="text"
                value={identifier}
                autoFocus
                onChange={(e) => setIdentifier(e.target.value)}
                disabled={busy}
              />
            </label>
            <button type="submit" className="login-submit" disabled={busy}>
              {busy ? "…" : "Send reset link"}
            </button>
          </>
        )}
        <Link to="/login" className="login-toggle">Back to sign in</Link>
      </form>
    </main>
  );
}
