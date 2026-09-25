"""Auth router — port of server/routes/auth.js (email/password, admin, demo,
change-password). Mobile OTP endpoints are stubbed to 501 until the notify
service (SMS provider) is ported; demo OTP code 123456 parity is preserved in
the notify stub for local flows that need it."""
import secrets
import time

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..db import get_db
from ..models import AuditLog, User
from ..security import AuthError, current_auth, sign_token
from ..services.auth_helpers import (check_lock, hash_password, login_ok,
                                     log_login, refuse_inactive,
                                     register_failure, verify_password)
from ..util import bad, http_error, v_email, v_str

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()


def demo_on() -> bool:
    return settings.demo_mode or settings.environment != "production"


def _new_uid() -> str:
    return "u" + format(int(time.time() * 1000), "x") + secrets.token_hex(2)


class EmailBody(BaseModel):
    email: str
    password: str
    name: str | None = None


class AdminBody(BaseModel):
    email: str
    password: str


class ChangePwBody(BaseModel):
    currentPassword: str
    newPassword: str


@router.post("/email")
async def email_login(body: EmailBody, request: Request, db: AsyncSession = Depends(get_db)):
    email = v_email(body.email)
    if len(body.password) < 8:
        raise bad("Password needs at least 8 characters")
    u = (await db.execute(
        select(User).where(User.email == email, User.role == "customer"))).scalar_one_or_none()
    if u:
        refuse_inactive(u)
        if not u.pass_hash:
            raise bad("This account uses mobile OTP. Please log in with your mobile number.")
        check_lock(u)
        if not verify_password(body.password, u.pass_hash):
            await log_login(db, u.id, "email", False, "wrong password", request.client.host if request.client else "")
            await register_failure(db, u.id)
            raise http_error(401, "Incorrect email or password")
    else:
        uid = _new_uid()
        u = User(id=uid, role="customer",
                 name=v_str(body.name, "Name", optional=True, max_len=80) or "Devotee",
                 email=email, pass_hash=hash_password(body.password),
                 pts=50, pref='{"deity":"","lang":"English","wa":true,"sms":true,"em":true}',
                 joined=time.strftime("%Y-%m-%d"), created_at=int(time.time() * 1000))
        db.add(u)
        await db.flush()
    meta = await login_ok(db, u, "email", request.client.host if request.client else "")
    return {"token": sign_token(u.id, u.role), "role": "customer",
            "mustChangePassword": meta["mustChangePassword"]}


@router.post("/admin")
async def admin_login(body: AdminBody, request: Request, db: AsyncSession = Depends(get_db)):
    u = (await db.execute(
        select(User).where(User.role == "admin",
                           User.email == str(body.email or "").lower()))).scalar_one_or_none()
    if u and u.status and u.status != "active":
        await log_login(db, u.id, "admin", False, u.status, request.client.host if request.client else "")
        raise http_error(403, "This admin account is " + u.status + ".")
    if u:
        check_lock(u)
    if not u or not verify_password(body.password, u.pass_hash or ""):
        if u:
            await log_login(db, u.id, "admin", False, "wrong password", request.client.host if request.client else "")
            await register_failure(db, u.id)
        raise http_error(401, "Incorrect credentials")
    meta = await login_ok(db, u, "admin", request.client.host if request.client else "")
    return {"token": sign_token(u.id, "admin"), "role": "admin",
            "mustChangePassword": meta["mustChangePassword"]}


@router.post("/change-password")
async def change_password(body: ChangePwBody, request: Request,
                          auth: dict | None = Depends(current_auth),
                          db: AsyncSession = Depends(get_db)):
    if not auth:
        raise AuthError(401, "Please log in")
    u = await db.get(User, auth["uid"])
    if not u or not u.pass_hash:
        raise bad("This account has no password set. Log in with your mobile OTP.")
    if not verify_password(body.currentPassword, u.pass_hash):
        await register_failure(db, u.id)
        raise http_error(401, "Current password is incorrect")
    if len(body.newPassword) < 8:
        raise bad("New password needs at least 8 characters")
    if body.newPassword == body.currentPassword:
        raise bad("Choose a password you have not used here before")
    u.pass_hash = hash_password(body.newPassword)
    u.force_change = 0
    db.add(AuditLog(
        actor_user_id=u.id, actor_role=u.role, action="password.change",
        entity="user", entity_id=u.id, detail="{}", created_at=int(time.time() * 1000)))
    await db.flush()
    return {"ok": True, "mustChangePassword": False}


@router.post("/otp/send")
async def otp_send(body: dict, db: AsyncSession = Depends(get_db)):
    """Issue an OTP. Demo mode fixes the code at 123456 (Node parity); the
    response carries devOtp outside production so local flows keep working."""
    from ..services.otp import issue
    return await issue(db, (body or {}).get("mobile"))


@router.post("/otp/verify")
async def otp_verify(body: dict, request: Request, db: AsyncSession = Depends(get_db)):
    """Verify the OTP; creates the customer on first login (Node parity).
    as='pandit' signs into the pandit account bound to that mobile."""
    from ..models import Pandit
    from ..services.otp import verify
    b = body or {}
    mobile = await verify(db, b.get("mobile"), b.get("otp"))
    ip = request.client.host if request.client else ""
    if b.get("as") == "pandit":
        p = (await db.execute(select(Pandit).where(Pandit.mobile == mobile))).scalar_one_or_none()
        if not p:
            raise http_error(404, "No pandit account for this number. Register first.")
        u = await db.get(User, p.user_id)
        if not u:
            raise http_error(404, "No pandit account for this number. Register first.")
        refuse_inactive(u)
        meta = await login_ok(db, u, "mobile-otp", ip)
        return {"token": sign_token(u.id, "pandit", p.id), "role": "pandit",
                "mustChangePassword": meta["mustChangePassword"]}
    u = (await db.execute(
        select(User).where(User.mobile == mobile, User.role == "customer"))).scalar_one_or_none()
    if not u:
        if (await db.execute(select(User).where(User.mobile == mobile).limit(1))).scalar_one_or_none():
            raise bad("This number belongs to a partner account")
        uid = _new_uid()
        u = User(id=uid, role="customer",
                 name=v_str(b.get("name"), "Name", optional=True, max_len=80) or "Devotee",
                 mobile=mobile, pts=50,
                 pref='{"deity":"","lang":"English","wa":true,"sms":true,"em":true}',
                 joined=time.strftime("%Y-%m-%d"), created_at=int(time.time() * 1000))
        db.add(u)
        await db.flush()
    refuse_inactive(u)
    meta = await login_ok(db, u, "mobile-otp", ip)
    return {"token": sign_token(u.id, u.role), "role": "customer",
            "mustChangePassword": meta["mustChangePassword"]}


@router.post("/demo")
async def demo_login(body: dict, db: AsyncSession = Depends(get_db)):
    """Demo shortcuts, only when demo mode is on (parity with /auth/demo)."""
    if not demo_on():
        raise http_error(404, "Not found")
    if body.get("role") == "pandit":
        from ..models import Pandit
        p = (await db.execute(select(Pandit).where(Pandit.id == "p1"))).scalar_one_or_none()
        if not p:
            raise http_error(404, "No demo data")
        u = await db.get(User, p.user_id)
        refuse_inactive(u)
        meta = await login_ok(db, u, "demo")
        return {"token": sign_token(u.id, "pandit", p.id), "role": "pandit",
                "mustChangePassword": meta["mustChangePassword"]}
    u = (await db.execute(select(User).where(User.id == "u1"))).scalar_one_or_none()
    if not u:
        raise http_error(404, "No demo data")
    refuse_inactive(u)
    meta = await login_ok(db, u, "demo")
    return {"token": sign_token(u.id, u.role), "role": u.role,
            "mustChangePassword": meta["mustChangePassword"]}


@router.get("/me")
async def me(auth: dict | None = Depends(current_auth), db: AsyncSession = Depends(get_db)):
    if not auth:
        raise AuthError(401, "Please log in")
    u = await db.get(User, auth["uid"])
    return {"uid": u.id, "role": u.role, "name": u.name, "email": u.email,
            "status": u.status, "mustChangePassword": bool(u.force_change)}
