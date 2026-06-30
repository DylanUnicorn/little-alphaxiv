"""Admin CLI: reset a user's password directly in the DB.

Escape hatch for the "I'm locked out right now" case — works even for accounts
with no email on file (which can't use the email reset flow). Does NOT need the
Fernet key: password hashing is bcrypt, independent of API-key encryption.

Usage (run from anywhere; resolves the DB path under backend/):
    python tools/reset_password.py <username>

You'll be prompted for the new password (not echoed). The script then:
  1. Looks up the user by username (case-insensitive).
  2. Updates password_hash to bcrypt(new_password).
  3. Optionally deletes all of that user's sessions (so any old cookie dies).

Run inside the Agent_env conda env (bcrypt is a backend dependency there).
"""
from __future__ import annotations

import getpass
import os
import sqlite3
import sys
from pathlib import Path

import bcrypt


def _db_path() -> Path:
    backend = Path(__file__).resolve().parent.parent / "backend"
    url = os.environ.get("LAX_DATABASE_URL", "sqlite:///./data/little_alphaxiv.db")
    fname = url.split("///")[-1] if "///" in url else "data/little_alphaxiv.db"
    p = Path(fname)
    if not p.is_absolute():
        p = backend / p
    return p


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("Usage: python tools/reset_password.py <username>", file=sys.stderr)
        return 2
    username = argv[1].strip().lower()
    db = _db_path()
    if not db.exists():
        print(f"[reset] DB not found at {db}. Start the backend once first.", file=sys.stderr)
        return 1
    con = sqlite3.connect(str(db))
    try:
        row = con.execute(
            "SELECT id, username, email FROM user WHERE lower(username)=?",
            (username,),
        ).fetchone()
        if row is None:
            print(f"[reset] no user named {username!r}", file=sys.stderr)
            return 1
        uid, uname, email = row
        print(f"[reset] user: {uname} (id={uid}, email={email or '<none>'})")
        pw = getpass.getpass("New password: ")
        if len(pw) < 8:
            print("[reset] password must be >= 8 chars", file=sys.stderr)
            return 1
        pw2 = getpass.getpass("Confirm: ")
        if pw != pw2:
            print("[reset] passwords do not match", file=sys.stderr)
            return 1
        hashed = bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()
        con.execute("UPDATE user SET password_hash=? WHERE id=?", (hashed, uid))
        n_sess = con.execute(
            "SELECT count(*) FROM session WHERE user_id=?", (uid,)
        ).fetchone()[0]
        if n_sess:
            ans = input(
                f"[reset] delete {n_sess} existing session(s) for this user? [y/N] "
            ).strip().lower()
            if ans in ("y", "yes"):
                con.execute("DELETE FROM session WHERE user_id=?", (uid,))
                con.commit()
                print(f"[reset] cleared {n_sess} session(s); old cookies now invalid.")
            else:
                con.commit()
                print("[reset] sessions kept (old cookies remain valid until expiry).")
        else:
            con.commit()
        print(f"[reset] done. password updated for {uname}.")
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
