"""Password lifecycle + login accounting — port of the helpers in
server/routes/auth.js: lockout (5 fails -> 15 min), login stamping, one-time
hashed reset tokens, and login_activity rows. Password hashes are bcrypt, so
existing Node-era hashes verify here unchanged (important for the data swap)."""
import hashlib
import secrets
import time

import bcrypt
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import LoginActivity, PasswordReset, User
from ..util import http_error

LOCK_AFTER = 5          # consecutive failures
LOCK_MINUTES = 15


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=10)).decode()


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except ValueError:
        return False


def now_ms() -> int:
    return int(time.time() * 1000)


async def log_login(db: AsyncSession, user_id: str | None, method: str, ok: bool,
                    reason: str = "", ip: str = "") -> None:
    db.add(LoginActivity(user_id=user_id, method=method, ok=1 if ok else 0,
                         reason=reason[:200], ip=ip or "", ts=now_ms()))
    await db.flush()


def check_lock(u: User) -> None:
    if u.locked_until and u.locked_until > now_ms():
        mins = max(1, (u.locked_until - now_ms()) // 60000)
        raise http_error(429, f"Account temporarily locked after failed attempts. Try again in {mins} minute(s).")


async def register_failure(db: AsyncSession, user_id: str) -> None:
    u = await db.get(User, user_id)
    if not u:
        return
    fails = (u.failed_logins or 0) + 1
    u.failed_logins = fails
    u.locked_until = now_ms() + LOCK_MINUTES * 60_000 if fails >= LOCK_AFTER else None
    await db.flush()
    if fails >= LOCK_AFTER:
        await log_login(db, user_id, "email", False, "locked after 5 failures")


async def login_ok(db: AsyncSession, u: User, method: str, ip: str = "") -> dict:
    u.last_login_at = now_ms()
    u.last_login_method = method
    u.failed_logins = 0
    u.locked_until = None
    await db.flush()
    await log_login(db, u.id, method, True, "", ip)
    return {"mustChangePassword": bool(u.force_change)}


async def issue_password_reset(db: AsyncSession, user_id: str, created_by: str | None) -> str:
    """One-time, hashed, 30-minute reset token; the raw token is shown once."""
    raw = secrets.token_urlsafe(24)
    db.add(PasswordReset(user_id=user_id, token_hash=hashlib.sha256(raw.encode()).hexdigest(),
                         expires=now_ms() + 30 * 60_000, used=0,
                         created_by=created_by, created_at=now_ms()))
    await db.flush()
    return raw


def refuse_inactive(u: User | None) -> None:
    if u and u.status and u.status != "active":
        msg = ("Your account is suspended. Please contact support."
               if u.status == "suspended" else "This account has been disabled. Please contact support.")
        raise http_error(403, msg)
