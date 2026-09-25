"""Auth primitives — JWT + bcrypt — ported 1:1 from server/auth.js:
same claims { uid, role, pid }, same 48h expiry, same DB re-check semantics
(role changes / suspensions take effect immediately even with a live token)."""
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .db import get_db
from .models import Pandit, User

settings = get_settings()


def sign_token(user_id: str, role: str, pid: str | None = None) -> str:
    payload = {
        "uid": user_id,
        "role": role,
        "pid": pid,
        "exp": datetime.now(timezone.utc) + timedelta(hours=settings.token_expire_hours),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


class AuthError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message


async def current_auth(
    request: Request, db: AsyncSession = Depends(get_db)
) -> dict | None:
    """Bearer-token dependency. Re-checks the user in the DB on every request so
    deletions, role changes and suspended/disabled accounts take effect at once."""
    h = request.headers.get("authorization", "")
    if not h.startswith("Bearer "):
        return None
    try:
        payload = jwt.decode(h[7:], settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.PyJWTError:
        return None
    row = (await db.execute(select(User).where(User.id == payload.get("uid")))).scalar_one_or_none()
    if not row:
        return None
    if row.status == "suspended":
        raise AuthError(403, "Your account is suspended. Please contact support.")
    if row.status == "disabled":
        raise AuthError(403, "This account has been disabled. Please contact support.")
    pid = None
    if row.role == "pandit":
        pid = (await db.execute(select(Pandit.id).where(Pandit.user_id == row.id))).scalar_one_or_none()
    return {"uid": row.id, "role": row.role, "pid": pid}


def require_role(*roles: str):
    """Route dependency factory: 401 when anonymous, 403 when the role doesn't match."""
    async def dep(auth: dict | None = Depends(current_auth)) -> dict:
        if not auth:
            raise AuthError(401, "Please log in")
        if auth["role"] not in roles:
            raise AuthError(403, "Not allowed")
        return auth
    return dep
