// Login / Register page. On success the backend sets the httpOnly lax_session
// cookie; we hard-navigate to "/" so App's boot re-runs with the cookie and
// hydrates the stores.

import { useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../lib/api";

export default function Login() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const u = username.trim();
    if (u.length < 3) { setError("Username must be at least 3 characters."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (mode === "register") {
      const em = email.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { setError("Enter a valid email."); return; }
      setBusy(true);
      try {
        await api.register(u, em, password);
        window.location.assign("/");
        return;
      } catch (err) {
        setError((err as Error).message || "Registration failed.");
        setBusy(false);
        return;
      }
    }
    setBusy(true);
    try {
      await api.login(u, password);
      window.location.assign("/");
    } catch (err) {
      setError((err as Error).message || "Authentication failed.");
      setBusy(false);
    }
  }

  return (
    <main className="main-pane login-pane">
      <form className="login-card" onSubmit={submit}>
        <h1>Little Alphaxiv</h1>
        <p className="login-sub">
          {mode === "login" ? "Sign in to your account" : "Create an account"}
        </p>
        <label className="login-field">
          <span>Username</span>
          <input
            type="text"
            value={username}
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </label>
        {mode === "register" && (
          <label className="login-field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              autoComplete="email"
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
          </label>
        )}
        <label className="login-field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button type="submit" className="login-submit" disabled={busy}>
          {busy ? "…" : mode === "login" ? "Sign in" : "Register"}
        </button>
        {mode === "login" && (
          <Link to="/forgot" className="login-toggle">Forgot password?</Link>
        )}
        <button
          type="button"
          className="login-toggle"
          onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}
          disabled={busy}
        >
          {mode === "login" ? "Need an account? Register" : "Already have an account? Sign in"}
        </button>
        <p className="login-hint">
          Your chat history, annotations, and provider keys are stored on the
          server (keys encrypted at rest), tied to this account — so switching
          browsers just means signing back in.
        </p>
      </form>
    </main>
  );
}
