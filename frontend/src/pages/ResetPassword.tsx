// Reset-password page: opened from the email link /reset?token=…

import { useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import * as api from "../lib/api";

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!token) {
    return (
      <main className="main-pane login-pane">
        <div className="login-card">
          <h1>Invalid link</h1>
          <p className="login-hint">This reset link is missing a token.</p>
          <Link to="/forgot" className="login-toggle">Request a new link</Link>
        </div>
      </main>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (pw !== pw2) { setError("Passwords do not match."); return; }
    setBusy(true);
    try {
      await api.resetPassword(token, pw);
      // Backend set the session cookie → boot as authenticated.
      window.location.assign("/");
    } catch (err) {
      setError(
        (err as Error).message ||
          "Reset failed. The link may be invalid or expired."
      );
      setBusy(false);
    }
  }

  return (
    <main className="main-pane login-pane">
      <form className="login-card" onSubmit={submit}>
        <h1>Set a new password</h1>
        <p className="login-sub">Choose a new password for your account.</p>
        <label className="login-field">
          <span>New password</span>
          <input
            type="password"
            value={pw}
            autoComplete="new-password"
            onChange={(e) => setPw(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </label>
        <label className="login-field">
          <span>Confirm password</span>
          <input
            type="password"
            value={pw2}
            autoComplete="new-password"
            onChange={(e) => setPw2(e.target.value)}
            disabled={busy}
          />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button type="submit" className="login-submit" disabled={busy}>
          {busy ? "…" : "Reset password"}
        </button>
        <Link to="/login" className="login-toggle">Back to sign in</Link>
      </form>
    </main>
  );
}
