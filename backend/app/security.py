"""Security primitives: API-key encryption at rest, password hashing, session signing.

Three concerns, all isolated here so routers never touch crypto directly:

  * Fernet symmetric encryption — encrypts stored LLM / search-source / Zotero
    API keys at rest. The plaintext key lives only in: an authenticated request
    body, backend memory for the duration of one upstream call, or returned to
    the owner who stored it. Never logged.
  * bcrypt — password hashing with a per-user salt; constant-time verify.
  * itsdangerous — signs the session cookie value so a stolen DB row id alone
    can't be replayed as a cookie. The sessions table is still the source of
    truth for logout / expiry; the signature is a cheap pre-filter for bad
    tokens (no DB hit needed to reject a tampered cookie).
"""
from __future__ import annotations

import os
import secrets
from typing import Optional

import bcrypt
from cryptography.fernet import Fernet, InvalidToken
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

# ---------------------------------------------------------------------------
# Secret-key management
# ---------------------------------------------------------------------------

# A Fernet key is 32 url-safe base64 bytes. The SAME key also seeds the
# itsdangerous serializer (itsdangerous derives its own signing key from this).
# Losing it orphans every encrypted API key AND every active session.
SECRET_KEY_ENV = "LAX_SECRET_KEY"
# backend/app/security.py → up two dirs → backend/.env
_env_file = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")


def _read_env_file_value(path: str, key: str) -> str:
    """Read KEY=value from a .env file (simple parser; no quoting/escaping)."""
    if not os.path.exists(path):
        return ""
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                if k.strip() == key:
                    return v.strip()
    except OSError:
        pass
    return ""


def _ensure_secret_key() -> str:
    """Return a valid Fernet key for LAX_SECRET_KEY.

    Resolution order: env var → backend/.env value → generate + write to
    backend/.env on first run. Persisting to .env lets the server restart
    without re-setting the env var (run.sh / run.bat don't load .env). If a
    .env exists but has NO key line, generate one into it (refusing would
    strand a user whose auto-generated file got the line deleted).
    """
    key = os.environ.get(SECRET_KEY_ENV, "").strip()
    if key:
        return key
    key = _read_env_file_value(_env_file, SECRET_KEY_ENV)
    if key:
        return key

    # First run: generate and persist so it survives restarts.
    generated = Fernet.generate_key().decode()
    os.makedirs(os.path.dirname(_env_file), exist_ok=True)
    with open(_env_file, "a", encoding="utf-8") as f:
        f.write("\n# Auto-generated on first run. KEEP SECRET. Losing it orphans all encrypted keys + sessions.\n")
        f.write(f"{SECRET_KEY_ENV}={generated}\n")
    os.environ[SECRET_KEY_ENV] = generated
    return generated


# Initialized once at startup by init_security(); routers call encrypt/decrypt.
_fernet: Optional[Fernet] = None
_signer: Optional[URLSafeTimedSerializer] = None


def init_security() -> None:
    """Initialize the Fernet + signer from LAX_SECRET_KEY. Call once at startup."""
    global _fernet, _signer
    key = _ensure_secret_key()
    _fernet = Fernet(key.encode())
    _signer = URLSafeTimedSerializer(key, salt="lax-session")


def _require() -> tuple[Fernet, URLSafeTimedSerializer]:
    if _fernet is None or _signer is None:
        # Routers run after lifespan init, but be defensive.
        init_security()
    assert _fernet is not None and _signer is not None
    return _fernet, _signer


# ---------------------------------------------------------------------------
# API-key encryption at rest (Fernet)
# ---------------------------------------------------------------------------


def encrypt(plaintext: str) -> str:
    """Encrypt a plaintext secret for storage. Empty input → empty output."""
    if not plaintext:
        return ""
    f, _ = _require()
    return f.encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
    """Decrypt a stored secret. Empty/garbage → empty string (never raises)."""
    if not ciphertext:
        return ""
    f, _ = _require()
    try:
        return f.decrypt(ciphertext.encode()).decode()
    except InvalidToken:
        return ""


def mask_key(plaintext: str) -> str:
    """Return a non-sensitive display mask of an API key (first4…last4)."""
    if not plaintext:
        return ""
    if len(plaintext) <= 8:
        return "•" * len(plaintext)
    return f"{plaintext[:4]}…{plaintext[-4:]}"


# ---------------------------------------------------------------------------
# Password hashing (bcrypt)
# ---------------------------------------------------------------------------


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    if not plain or not hashed:
        return False
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())  # constant-time
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# Session cookie signing (itsdangerous)
# ---------------------------------------------------------------------------

SESSION_COOKIE = "lax_session"


def session_max_age_seconds() -> int:
    days = int(os.environ.get("LAX_SESSION_MAX_AGE_DAYS", "30"))
    return days * 86400


def cookie_secure() -> bool:
    """True → Set-Cookie secure flag (behind https). False for LAN http."""
    return os.environ.get("LAX_SECURE_COOKIES", "false").strip().lower() in ("1", "true", "yes")


def new_session_id() -> str:
    """A 32-byte url-safe random token (the sessions table PK)."""
    return secrets.token_urlsafe(32)


def sign_session(session_id: str, expires_at: int) -> str:
    """Sign {sid, exp} into an opaque cookie value."""
    _, signer = _require()
    return signer.dumps({"sid": session_id, "exp": expires_at})


def unsign_session(token: str) -> Optional[str]:
    """Verify signature + max_age, return the session id or None."""
    if not token:
        return None
    _, signer = _require()
    try:
        data = signer.loads(token, max_age=session_max_age_seconds())
    except (BadSignature, SignatureExpired):
        return None
    sid = data.get("sid")
    return sid if isinstance(sid, str) and sid else None
