"""SQLAlchemy models mirroring the Node/SQLite schema 1:1 (same table and column
names, same TEXT-stored-JSON convention) so the later SQLite→Postgres swap is a
straight INSERT … SELECT and both backends can read the same shape."""
from sqlalchemy import BigInteger, Boolean, CheckConstraint, Float, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base

MS = BigInteger  # Node parity: epoch milliseconds


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    role: Mapped[str] = mapped_column(String(20), default="customer")
    name: Mapped[str | None] = mapped_column(String(120))
    mobile: Mapped[str | None] = mapped_column(String(15), unique=True)
    email: Mapped[str | None] = mapped_column(String(120), unique=True)
    pass_hash: Mapped[str | None] = mapped_column(String(100))
    pts: Mapped[int] = mapped_column(Integer, default=0)
    plus: Mapped[int] = mapped_column(Integer, default=0)
    pref: Mapped[str] = mapped_column(Text, default="{}")   # JSON text (Node parity)
    addr: Mapped[str] = mapped_column(Text, default="[]")
    fam: Mapped[str] = mapped_column(Text, default="[]")
    joined: Mapped[str | None] = mapped_column(String(10))
    created_at: Mapped[int | None] = mapped_column(MS)
    # migration 009: account management
    status: Mapped[str] = mapped_column(String(20), default="active")  # active|suspended|disabled
    force_change: Mapped[int] = mapped_column(Integer, default=0)
    last_login_at: Mapped[int | None] = mapped_column(MS)
    last_login_method: Mapped[str] = mapped_column(String(20), default="")
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[int | None] = mapped_column(MS)


class Pandit(Base):
    __tablename__ = "pandits"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(40))
    name: Mapped[str] = mapped_column(String(120))
    city: Mapped[str | None] = mapped_column(String(80))
    exp: Mapped[int] = mapped_column(Integer, default=0)
    langs: Mapped[str] = mapped_column(Text, default="[]")
    spec: Mapped[str] = mapped_column(Text, default="[]")
    rating: Mapped[float] = mapped_column(Float, default=0)
    rev: Mapped[int] = mapped_column(Integer, default=0)
    done: Mapped[int] = mapped_column(Integer, default=0)
    pf: Mapped[float] = mapped_column(Float, default=1)
    bio: Mapped[str | None] = mapped_column(Text)
    color: Mapped[str | None] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    featured: Mapped[int] = mapped_column(Integer, default=0)
    off: Mapped[str] = mapped_column(Text, default="[]")
    mobile: Mapped[str | None] = mapped_column(String(15), unique=True)
    avail: Mapped[int] = mapped_column(Integer, default=1)
    kyc: Mapped[str] = mapped_column(Text, default="{}")


class Puja(Base):
    __tablename__ = "pujas"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    hindi: Mapped[str | None] = mapped_column(String(160))
    cat: Mapped[str | None] = mapped_column(String(40))
    icon: Mapped[str | None] = mapped_column(String(20))
    dur: Mapped[int | None] = mapped_column(Integer)
    price: Mapped[int] = mapped_column(Integer)
    deity: Mapped[str | None] = mapped_column(String(80))
    ben: Mapped[str | None] = mapped_column(Text)
    ben_hi: Mapped[str] = mapped_column(Text, default="")   # migration 007
    kit: Mapped[str | None] = mapped_column(Text)
    pop: Mapped[int] = mapped_column(Integer, default=0)
    tags: Mapped[str] = mapped_column(Text, default="")
    hidden: Mapped[int] = mapped_column(Integer, default=0)


class PujaMedia(Base):
    __tablename__ = "puja_media"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    puja_id: Mapped[str] = mapped_column(String(40), index=True)
    booking_id: Mapped[str | None] = mapped_column(String(40), index=True)
    pandit_id: Mapped[str | None] = mapped_column(String(40), index=True)
    uploaded_by: Mapped[str | None] = mapped_column(String(40))
    orig_name: Mapped[str] = mapped_column(String(160), default="")
    filename: Mapped[str] = mapped_column(String(200))       # server-generated name in uploads/media
    mime: Mapped[str] = mapped_column(String(60))
    size: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(30), default="PENDING_ADMIN_REVIEW")
    is_primary: Mapped[int] = mapped_column(Integer, default=0)
    is_published: Mapped[int] = mapped_column(Integer, default=0)
    display_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[int] = mapped_column(MS)
    updated_at: Mapped[int | None] = mapped_column(MS)
    # migration 010: provenance / licensing / alt text / category / thumbnail
    source: Mapped[str] = mapped_column(String(10), default="admin")
    license: Mapped[str] = mapped_column(Text, default="")
    credit: Mapped[str] = mapped_column(Text, default="")
    creator: Mapped[str] = mapped_column(Text, default="")
    credit_url: Mapped[str] = mapped_column(Text, default="")
    alt_text: Mapped[str] = mapped_column(Text, default="")
    category: Mapped[str] = mapped_column(String(10), default="puja")
    thumb: Mapped[str] = mapped_column(String(200), default="")
    # migration 011: WebP variants + rejection feedback
    webp: Mapped[str] = mapped_column(String(200), default="")
    thumb_webp: Mapped[str] = mapped_column(String(200), default="")
    reject_reason: Mapped[str] = mapped_column(String(220), default="")

    __table_args__ = (
        CheckConstraint("status IN ('PENDING_ADMIN_REVIEW','APPROVED','REJECTED')", name="ck_puja_media_status"),
        CheckConstraint("source IN ('seeded','admin','pandit')", name="ck_puja_media_source"),
        CheckConstraint("category IN ('puja','ritual','temple','seva')", name="ck_puja_media_category"),
        Index("idx_puja_media_status", "status", "created_at"),
        Index("idx_puja_media_source", "source"),
        Index("idx_puja_media_webp", "is_published", "status"),
    )


class Booking(Base):
    __tablename__ = "bookings"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(40), index=True)
    puja_id: Mapped[str] = mapped_column(String(40))
    mode: Mapped[str] = mapped_column(String(20))
    date: Mapped[str] = mapped_column(String(10))
    slot: Mapped[str] = mapped_column(String(30))
    addr: Mapped[str | None] = mapped_column(Text)
    temple_id: Mapped[str | None] = mapped_column(String(40))
    pandit_id: Mapped[str | None] = mapped_column(String(40), index=True)
    pst: Mapped[str | None] = mapped_column(String(30))
    sam: Mapped[str] = mapped_column(Text, default="[]")
    pra: Mapped[str] = mapped_column(Text, default="[]")
    notes: Mapped[str | None] = mapped_column(Text)
    member: Mapped[str | None] = mapped_column(Text)
    coupon: Mapped[str | None] = mapped_column(String(40))
    q: Mapped[str] = mapped_column(Text, default="{}")   # quote JSON
    status: Mapped[str] = mapped_column(String(30), default="Requested")
    pay: Mapped[str] = mapped_column(Text, default="{}")
    ops: Mapped[str] = mapped_column(Text, default="{}")
    media: Mapped[str] = mapped_column(Text, default="[]")
    review: Mapped[str | None] = mapped_column(Text)
    created: Mapped[int | None] = mapped_column(MS)
    log: Mapped[str] = mapped_column(Text, default="[]")
    refund: Mapped[str | None] = mapped_column(Text)
    esc: Mapped[int] = mapped_column(Integer, default=0)
    review_hidden: Mapped[int] = mapped_column(Integer, default=0)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor_user_id: Mapped[str | None] = mapped_column(String(40), index=True)
    actor_role: Mapped[str | None] = mapped_column(String(20))
    action: Mapped[str] = mapped_column(String(60))
    entity: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[str | None] = mapped_column(String(40), index=True)
    detail: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[int] = mapped_column(MS)


class LoginActivity(Base):
    __tablename__ = "login_activity"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str | None] = mapped_column(String(40), index=True)
    method: Mapped[str] = mapped_column(String(20))          # mobile-otp | email | admin | demo
    ok: Mapped[int] = mapped_column(Integer, default=1)
    reason: Mapped[str] = mapped_column(String(200), default="")
    ip: Mapped[str] = mapped_column(String(60), default="")
    ts: Mapped[int] = mapped_column(MS)


class PasswordReset(Base):
    __tablename__ = "password_resets"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String(40), index=True)
    token_hash: Mapped[str] = mapped_column(String(64))
    expires: Mapped[int] = mapped_column(MS)
    used: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[str | None] = mapped_column(String(40))
    created_at: Mapped[int] = mapped_column(MS)
