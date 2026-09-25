"""OTP issue/verify — port of the helpers in server/routes/auth.js. Demo mode
fixes the code at 123456 (Node parity); codes are hashed (sha256 of
mobile:code:secret) and expire after 5 minutes with a 5-attempt cap."""
import hashlib
import os
import time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..models import Otp
from ..util import bad, http_error, v_mobile


def _hash(mobile: str, code: str) -> str:
    secret = os.environ.get("JWT_SECRET", get_settings().jwt_secret)
    return hashlib.sha256(f"{mobile}:{code}:{secret}".encode()).hexdigest()


def demo_on() -> bool:
    env = get_settings().environment
    return (os.environ.get("DEMO_MODE") or ("false" if env == "production" else "true")).lower() == "true"


async def issue(db: AsyncSession, mobile_raw) -> dict:
    mobile = v_mobile(mobile_raw)
    code = "123456" if demo_on() else str(__import__("secrets").randbelow(900000) + 100000)
    row = (await db.execute(select(Otp).where(Otp.mobile == mobile))).scalar_one_or_none()
    if row:
        row.code_hash = _hash(mobile, code)
        row.expires = int(time.time() * 1000) + 5 * 60_000
        row.attempts = 0
    else:
        db.add(Otp(mobile=mobile, code_hash=_hash(mobile, code),
                   expires=int(time.time() * 1000) + 5 * 60_000, attempts=0))
    await db.flush()
    # Node parity: sendOtp() goes through the notify service; here the response
    # carries devOtp outside production so local/demo flows keep working.
    resp = {"ok": True}
    if get_settings().environment != "production" and demo_on():
        resp["devOtp"] = code
    return resp


async def verify(db: AsyncSession, mobile_raw, code) -> str:
    mobile = v_mobile(mobile_raw)
    row = (await db.execute(select(Otp).where(Otp.mobile == mobile))).scalar_one_or_none()
    now_ms = int(time.time() * 1000)
    if not row or (row.expires or 0) < now_ms:
        raise bad("OTP expired. Request a new one.")
    if (row.attempts or 0) >= 5:
        raise http_error(429, "Too many wrong attempts. Request a new OTP.")
    import hmac as _hmac
    if not _hmac.compare_digest(_hash(mobile, str(code or "")), row.code_hash or ""):
        row.attempts = (row.attempts or 0) + 1
        await db.flush()
        raise bad("Incorrect OTP")
    await db.delete(row)
    await db.flush()
    return mobile
