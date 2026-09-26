"""SQLAlchemy models mirroring the Node/SQLite schema 1:1 (same table and column
names, same TEXT-stored-JSON convention) so the later SQLite→Postgres swap is a
straight INSERT … SELECT and both backends can read the same shape."""
from sqlalchemy import BigInteger, Boolean, CheckConstraint, Float, Index, Integer, String, Text, text
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


class Kit(Base):
    __tablename__ = "kits"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str | None] = mapped_column(String(120))
    price: Mapped[int | None] = mapped_column(Integer)
    icon: Mapped[str | None] = mapped_column(String(20))
    items: Mapped[str] = mapped_column(Text, default="[]")
    stock: Mapped[int] = mapped_column(Integer, default=0)
    active: Mapped[int] = mapped_column(Integer, default=1)   # db.js column-add loop parity


class Prasad(Base):
    __tablename__ = "prasad"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str | None] = mapped_column(String(120))
    price: Mapped[int | None] = mapped_column(Integer)
    icon: Mapped[str | None] = mapped_column(String(20))
    descr: Mapped[str | None] = mapped_column(Text)
    stock: Mapped[int | None] = mapped_column(Integer)        # NULL = unlimited
    active: Mapped[int] = mapped_column(Integer, default=1)


class Temple(Base):
    __tablename__ = "temples"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str | None] = mapped_column(String(120))
    city: Mapped[str | None] = mapped_column(String(80))
    deity: Mapped[str | None] = mapped_column(String(80))
    icon: Mapped[str | None] = mapped_column(String(20))
    pujas: Mapped[str] = mapped_column(Text, default="[]")
    offering: Mapped[int | None] = mapped_column(Integer)
    descr: Mapped[str | None] = mapped_column(Text)


class Festival(Base):
    __tablename__ = "festivals"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str | None] = mapped_column(String(120))
    date: Mapped[str | None] = mapped_column(String(10))
    pujas: Mapped[str] = mapped_column(Text, default="[]")
    note: Mapped[str | None] = mapped_column(Text)


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


class Notif(Base):
    __tablename__ = "notifs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str | None] = mapped_column(String(40))
    channel: Mapped[str | None] = mapped_column(String(20))
    message: Mapped[str | None] = mapped_column(Text)
    ts: Mapped[int | None] = mapped_column(MS)


class Order(Base):
    __tablename__ = "orders"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(40))
    items: Mapped[str | None] = mapped_column(Text)
    total: Mapped[int | None] = mapped_column(Integer)
    date: Mapped[str | None] = mapped_column(String(10))
    status: Mapped[str | None] = mapped_column(String(30))
    city: Mapped[str | None] = mapped_column(String(80))
    address: Mapped[str | None] = mapped_column(Text)


class Ticket(Base):
    __tablename__ = "tickets"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(40))
    booking_id: Mapped[str | None] = mapped_column(String(40))
    text: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str | None] = mapped_column(String(20))
    prio: Mapped[str | None] = mapped_column(String(10))


class Campaign(Base):
    __tablename__ = "campaigns"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str | None] = mapped_column(String(120))
    channel: Mapped[str | None] = mapped_column(String(20))
    audience: Mapped[str | None] = mapped_column(String(120))
    status: Mapped[str | None] = mapped_column(String(20))
    sent: Mapped[int] = mapped_column(Integer, default=0)


class Lead(Base):
    __tablename__ = "leads"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    type: Mapped[str | None] = mapped_column(String(20))
    name: Mapped[str | None] = mapped_column(String(120))
    details: Mapped[str | None] = mapped_column(Text)
    date: Mapped[str | None] = mapped_column(String(10))


class Payout(Base):
    __tablename__ = "payouts"
    id: Mapped[str] = mapped_column(String(60), primary_key=True)
    pandit_id: Mapped[str | None] = mapped_column(String(40))
    amount: Mapped[int | None] = mapped_column(Integer)
    date: Mapped[str | None] = mapped_column(String(10))
    status: Mapped[str | None] = mapped_column(String(20))
    booking_id: Mapped[str | None] = mapped_column(String(40))


class Coupon(Base):
    __tablename__ = "coupons"
    code: Mapped[str] = mapped_column(String(20), primary_key=True)
    type: Mapped[str | None] = mapped_column(String(10))          # pct | flat
    val: Mapped[int | None] = mapped_column(Integer)
    max: Mapped[int | None] = mapped_column(Integer)
    min: Mapped[int | None] = mapped_column(Integer)
    active: Mapped[int] = mapped_column(Integer, default=1)
    used: Mapped[int] = mapped_column(Integer, default=0)


class Banner(Base):
    __tablename__ = "banners"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    text: Mapped[str | None] = mapped_column(Text)
    enabled: Mapped[int] = mapped_column(Integer, default=1)


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[str | None] = mapped_column(Text)


class Otp(Base):
    __tablename__ = "otps"
    mobile: Mapped[str] = mapped_column(String(15), primary_key=True)
    code_hash: Mapped[str | None] = mapped_column(String(64))
    expires: Mapped[int | None] = mapped_column(MS)
    attempts: Mapped[int] = mapped_column(Integer, default=0)


class IdempotencyKey(Base):
    """Webhook replay protection (migration 008 parity): the same Razorpay event
    id is acknowledged exactly once — replays never double-mark a payment."""
    __tablename__ = "idempotency_keys"
    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    scope: Mapped[str] = mapped_column(String(40))
    result: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[int] = mapped_column(MS)


# --- kundali module (migrations 002/003/006/008) ------------------------------

class FamilyMember(Base):
    """Separately chargeable kundali subjects (migration 008)."""
    __tablename__ = "family_members"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    customer_id: Mapped[str] = mapped_column(String(40), index=True)
    relationship: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(120))
    gender: Mapped[str] = mapped_column(String(10), default="")
    dob: Mapped[str] = mapped_column(String(10), default="")
    tob: Mapped[str] = mapped_column(String(8), default="")
    birth_place: Mapped[str] = mapped_column(String(160), default="")
    city: Mapped[str] = mapped_column(String(80), default="")
    state: Mapped[str] = mapped_column(String(80), default="")
    country: Mapped[str] = mapped_column(String(80), default="")
    lat: Mapped[float | None] = mapped_column(Float)
    lon: Mapped[float | None] = mapped_column(Float)
    tz: Mapped[str] = mapped_column(String(40), default="")
    photo: Mapped[str] = mapped_column(String(200), default="")
    gotra: Mapped[str] = mapped_column(String(40), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[str | None] = mapped_column(String(30))   # sqlite datetime('now')
    updated_at: Mapped[str | None] = mapped_column(String(30))


class KundaliProfile(Base):
    __tablename__ = "kundali_profiles"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(40), index=True)
    name: Mapped[str] = mapped_column(String(120))
    gender: Mapped[str | None] = mapped_column(String(10))
    dob: Mapped[str] = mapped_column(String(10))
    tob: Mapped[str] = mapped_column(String(8))
    pob: Mapped[str] = mapped_column(String(160))
    lat: Mapped[float | None] = mapped_column(Float)
    lon: Mapped[float | None] = mapped_column(Float)
    tz: Mapped[str] = mapped_column(String(40), default="Asia/Kolkata")
    created_at: Mapped[int | None] = mapped_column(MS)
    # migration 005/006
    birth_time_accuracy: Mapped[str] = mapped_column(String(12), default="exact")
    purpose: Mapped[str] = mapped_column(String(40), default="")
    email: Mapped[str] = mapped_column(String(120), default="")
    mobile: Mapped[str] = mapped_column(String(15), default="")
    gotra: Mapped[str] = mapped_column(String(40), default="")
    whatsapp: Mapped[str] = mapped_column(String(15), default="")
    state: Mapped[str] = mapped_column(String(80), default="")
    country: Mapped[str] = mapped_column(String(80), default="")


class Kundali(Base):
    """A generated kundali (migration 003) + commercial billing (migration 008)."""
    __tablename__ = "kundalis"
    id: Mapped[str] = mapped_column(String(20), primary_key=True)
    profile_id: Mapped[str | None] = mapped_column(String(40), index=True)
    name: Mapped[str] = mapped_column(String(120))
    chart_data: Mapped[str] = mapped_column(Text, default="{}")
    planetary_data: Mapped[str] = mapped_column(Text, default="{}")
    lagna: Mapped[str] = mapped_column(String(40), default="")
    rashi: Mapped[str] = mapped_column(String(40), default="")
    nakshatra: Mapped[str] = mapped_column(String(40), default="")
    pada: Mapped[int | None] = mapped_column(Integer)
    dasha_data: Mapped[str] = mapped_column(Text, default="{}")
    navamsa_data: Mapped[str] = mapped_column(Text, default="{}")
    calculation_version: Mapped[str] = mapped_column(String(40), default="internal-ephemeris-v1")
    created_at: Mapped[int | None] = mapped_column(MS)
    # migration 008
    customer_id: Mapped[str | None] = mapped_column(String(40), index=True)
    family_member_id: Mapped[str | None] = mapped_column(String(40))
    relationship: Mapped[str] = mapped_column(String(20), default="")
    billing: Mapped[str] = mapped_column(String(20), default="FREE")
    price: Mapped[int] = mapped_column(Integer, default=0)
    discount: Mapped[int] = mapped_column(Integer, default=0)
    gst: Mapped[int] = mapped_column(Integer, default=0)
    final_amount: Mapped[int] = mapped_column(Integer, default=0)
    currency: Mapped[str] = mapped_column(String(8), default="INR")
    payment_id: Mapped[str] = mapped_column(String(60), default="")
    order_id: Mapped[str] = mapped_column(String(40), default="")
    payment_status: Mapped[str] = mapped_column(String(20), default="")
    idem_key: Mapped[str] = mapped_column(String(120), default="")

    __table_args__ = (
        Index("idx_kundali_idem", "idem_key", unique=True, sqlite_where=(text("idem_key != ''"))),
    )


class DoshAnalysis(Base):
    __tablename__ = "dosh_analysis"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kundali_id: Mapped[str] = mapped_column(String(20), index=True)
    dosh_type: Mapped[str] = mapped_column(String(40))
    detected: Mapped[int] = mapped_column(Integer, default=0)
    severity: Mapped[str] = mapped_column(String(10), default="none")
    confidence: Mapped[float | None] = mapped_column(Float)
    explanation: Mapped[str] = mapped_column(Text, default="")
    evidence: Mapped[str] = mapped_column(Text, default="[]")
    recommendation: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[int | None] = mapped_column(MS)
    # migration 006
    evidence_hi: Mapped[str] = mapped_column(Text, default="[]")


class PujaRecommendation(Base):
    __tablename__ = "puja_recommendations"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kundali_id: Mapped[str] = mapped_column(String(20), index=True)
    puja_id: Mapped[str | None] = mapped_column(String(40))
    recommendation_reason: Mapped[str] = mapped_column(Text, default="")
    priority: Mapped[str] = mapped_column(String(12), default="secondary")
    relevance_score: Mapped[int] = mapped_column(Integer, default=1)
    related_doshas: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[int | None] = mapped_column(MS)
    # migration 006
    reason_hi: Mapped[str] = mapped_column(Text, default="")


class PlaceIndex(Base):
    __tablename__ = "place_index"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    city: Mapped[str] = mapped_column(String(80), index=True)
    state: Mapped[str] = mapped_column(String(80), default="")
    country: Mapped[str] = mapped_column(String(80), default="India")
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    tz: Mapped[str] = mapped_column(String(40), default="Asia/Kolkata")
    population: Mapped[int | None] = mapped_column(Integer, default=0)


class HavanKund(Base):
    __tablename__ = "havan_kunds"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    material: Mapped[str] = mapped_column(String(20))
    size_in: Mapped[int] = mapped_column(Integer)
    price: Mapped[int] = mapped_column(Integer)
    descr: Mapped[str] = mapped_column(Text, default="")
    active: Mapped[int] = mapped_column(Integer, default=1)


class PujaKund(Base):
    __tablename__ = "puja_kunds"
    puja_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    kund_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    recommended: Mapped[int] = mapped_column(Integer, default=0)


class SamagriItem(Base):
    __tablename__ = "samagri_items"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    unit: Mapped[str] = mapped_column(String(20), default="pcs")
    category: Mapped[str] = mapped_column(String(40), default="general")
    active: Mapped[int] = mapped_column(Integer, default=1)


class PujaSamagri(Base):
    __tablename__ = "puja_samagri"
    puja_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    item_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    qty: Mapped[int] = mapped_column(Integer, default=1)


class KundaliCondition(Base):
    __tablename__ = "kundali_conditions"
    code: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    descr: Mapped[str] = mapped_column(Text, default="")
    severity: Mapped[str] = mapped_column(String(10), default="low")
    active: Mapped[int] = mapped_column(Integer, default=1)
    # migrations 005/006
    remedy: Mapped[str] = mapped_column(Text, default="")
    name_hi: Mapped[str] = mapped_column(Text, default="")
    descr_hi: Mapped[str] = mapped_column(Text, default="")
    remedy_hi: Mapped[str] = mapped_column(Text, default="")


class ConditionPujaRule(Base):
    __tablename__ = "condition_puja_rules"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    condition_code: Mapped[str] = mapped_column(String(40))
    puja_id: Mapped[str] = mapped_column(String(40))
    weight: Mapped[int] = mapped_column(Integer, default=1)
    priority: Mapped[str] = mapped_column(String(12), default="secondary")
    reason: Mapped[str] = mapped_column(Text, default="")
    reason_hi: Mapped[str] = mapped_column(Text, default="")

    __table_args__ = (
        Index("uq_cond_puja", "condition_code", "puja_id", unique=True),
    )


class KundaliActivity(Base):
    __tablename__ = "kundali_activity"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str | None] = mapped_column(String(40))
    action: Mapped[str] = mapped_column(String(40))
    detail: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[int | None] = mapped_column(MS)


class KundaliRecommendation(Base):
    """Legacy profile-scoped recommendations (migration 002)."""
    __tablename__ = "kundali_recommendations"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    profile_id: Mapped[str] = mapped_column(String(40), index=True)
    condition_code: Mapped[str] = mapped_column(String(40))
    puja_id: Mapped[str | None] = mapped_column(String(40))
    reason: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[int | None] = mapped_column(MS)


class KundaliAnalysis(Base):
    """Legacy profile-scoped analyses (migration 002); profile_id nullable for guests."""
    __tablename__ = "kundali_analysis"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    profile_id: Mapped[str | None] = mapped_column(String(40), index=True)
    summary: Mapped[str] = mapped_column(Text, default="{}")
    matched: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[int | None] = mapped_column(MS)


class ExportLog(Base):
    """Excel export audit trail (migration 008): one row per admin report download."""
    __tablename__ = "export_logs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    admin_id: Mapped[str] = mapped_column(String(40), index=True)
    report: Mapped[str] = mapped_column(String(60))
    filters: Mapped[str] = mapped_column(Text, default="")
    rows: Mapped[int] = mapped_column(Integer, default=0)
    ts: Mapped[int] = mapped_column(MS)


class CustomRequest(Base):
    """Customized puja requests with the full spec workflow (migration 007,
    rebuilt with the extended status set in migration 008)."""
    __tablename__ = "custom_requests"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(40))
    name: Mapped[str] = mapped_column(String(120))
    mobile: Mapped[str] = mapped_column(String(15))
    language: Mapped[str] = mapped_column(String(40), default="")
    requirement: Mapped[str] = mapped_column(Text, default="")
    purpose: Mapped[str] = mapped_column(String(40), default="")
    deity: Mapped[str] = mapped_column(String(80), default="")
    occasion: Mapped[str] = mapped_column(String(80), default="")
    preferred_date: Mapped[str] = mapped_column(String(10), default="")
    preferred_time: Mapped[str] = mapped_column(String(30), default="")
    location: Mapped[str] = mapped_column(String(160), default="")
    city: Mapped[str] = mapped_column(String(80), default="")
    state: Mapped[str] = mapped_column(String(80), default="")
    country: Mapped[str] = mapped_column(String(80), default="")
    participants: Mapped[int | None] = mapped_column(Integer)
    budget: Mapped[int | None] = mapped_column(Integer)
    kundali_id: Mapped[str] = mapped_column(String(20), default="")
    dosh_condition: Mapped[str] = mapped_column(String(60), default="")
    remedy: Mapped[str] = mapped_column(Text, default="")
    sankalp: Mapped[str] = mapped_column(Text, default="")
    samagri_req: Mapped[str] = mapped_column(Text, default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    attachments: Mapped[str] = mapped_column(Text, default="[]")
    status: Mapped[str] = mapped_column(String(40), default="NEW")
    admin_notes: Mapped[str] = mapped_column(Text, default="")
    pandit_notes: Mapped[str] = mapped_column(Text, default="")
    quote_amount: Mapped[int | None] = mapped_column(Integer)
    final_price: Mapped[int | None] = mapped_column(Integer)
    payment_status: Mapped[str] = mapped_column(String(20), default="")
    assigned_pandit_id: Mapped[str | None] = mapped_column(String(40))
    assigned_temple_id: Mapped[str | None] = mapped_column(String(40))
    booking_id: Mapped[str] = mapped_column(String(40), default="")
    history: Mapped[str] = mapped_column(Text, default="[]")
    admin_note: Mapped[str] = mapped_column(Text, default="")
    puja_id: Mapped[str | None] = mapped_column(String(40))
    created_at: Mapped[str | None] = mapped_column(String(30))   # sqlite datetime('now')
    updated_at: Mapped[str | None] = mapped_column(String(30))

    __table_args__ = (
        CheckConstraint("status IN ('NEW','UNDER_REVIEW','PANDIT_CONSULTATION','QUOTE_PREPARED',"
                        "'CUSTOMER_APPROVAL_PENDING','APPROVED','PAYMENT_PENDING','PAID','PANDIT_ASSIGNED',"
                        "'TEMPLE_ASSIGNED','SCHEDULED','IN_PROGRESS','COMPLETED','REJECTED','CANCELLED',"
                        "'EXPIRED','REFUNDED')", name="ck_custom_requests_status"),
    )
