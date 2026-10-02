"""Social Media CMS (additional-requirements Phase C) — Python twin of
server/services/socials.js.

The platform's social presence is admin-managed rows, never hard-coded footer
markup: an admin adds, orders, hides or deletes them and every write is
audited. Production starts empty; the demo seeder adds the sample
Facebook/Instagram/YouTube rows (plus one disabled international example) only
while DEMO_MODE is on.

The `icon` column stores a KEY into the frontend's built-in inline SVG set.
The server never renders markup: an unknown key simply falls back to the
generic globe icon in the footer, so a new platform can be added before its
glyph exists. URLs are http/https only.
"""
import json
import time

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import AuditLog, SocialLink
from ..util import bad, not_found, rid, v_int, v_str


def _now_ms() -> int:
    return int(time.time() * 1000)


def out(r: SocialLink) -> dict:
    return {"id": r.id, "platform": r.platform, "icon": r.icon or "", "url": r.url,
            "active": bool(r.active), "order": r.sort_order or 0, "created": r.created}


def _audit(db: AsyncSession, uid, action: str, entity_id, detail: dict,
           reason: str | None = None, old_value=None, new_value=None) -> None:
    db.add(AuditLog(actor_user_id=uid, actor_role="admin", action=action, entity="social_link",
                    entity_id=entity_id, detail=json.dumps(detail),
                    old_value=json.dumps(old_value) if old_value is not None else None,
                    new_value=json.dumps(new_value) if new_value is not None else None,
                    reason=reason, created_at=_now_ms()))


def _clean_url(x) -> str:
    u = v_str(x, "URL", max_len=300)
    if not u.lower().startswith(("http://", "https://")):
        raise bad("URL must start with http:// or https://")
    return u


def _clean_key(x, name: str) -> str:
    raw = v_str(x, name, max_len=30, optional=True).lower()
    return "".join(ch for ch in raw if ch.isalnum() or ch == "-")


def _clean_platform(x) -> str:
    return v_str(x, "Platform", max_len=40).lower()[:40]


async def get(db: AsyncSession, link_id: str) -> SocialLink | None:
    return await db.get(SocialLink, link_id)


async def list_all(db: AsyncSession) -> list[dict]:
    """Admin list: everything, in the order the footer draws it."""
    rows = (await db.execute(select(SocialLink).order_by(SocialLink.sort_order, SocialLink.id))).scalars().all()
    return [out(r) for r in rows]


async def list_active(db: AsyncSession) -> list[dict]:
    """Public list: active rows only (what /state hands the footer)."""
    rows = (await db.execute(select(SocialLink).where(SocialLink.active == 1)
                             .order_by(SocialLink.sort_order, SocialLink.id))).scalars().all()
    return [out(r) for r in rows]


async def create(db: AsyncSession, uid, b: dict) -> dict:
    b = b or {}
    platform = _clean_platform(b.get("platform"))
    url = _clean_url(b.get("url"))
    icon = _clean_key(b.get("icon"), "Icon")
    if b.get("order") is None:
        order = int((await db.execute(select(func.coalesce(func.max(SocialLink.sort_order), 0)))).scalar_one()) + 1
    else:
        order = v_int(b.get("order"), "Order", min_val=0, max_val=999)
    link_id = "sl" + rid(4)
    db.add(SocialLink(id=link_id, platform=platform, icon=icon, url=url,
                      active=1 if b.get("active") is None else (1 if b.get("active") else 0),
                      sort_order=order, created=_now_ms()))
    await db.flush()
    _audit(db, uid, "social.create", link_id, {"platform": platform, "url": url, "order": order})
    await db.commit()
    return out(await db.get(SocialLink, link_id))


async def update(db: AsyncSession, uid, link_id: str, b: dict) -> dict:
    s = await db.get(SocialLink, link_id)
    if not s:
        raise not_found("Social link not found")
    b = b or {}
    old = {"platform": s.platform, "active": bool(s.active)}
    if "platform" in b:
        s.platform = _clean_platform(b["platform"])
    if "url" in b:
        s.url = _clean_url(b["url"])
    if "icon" in b:
        s.icon = _clean_key(b["icon"], "Icon")
    if "order" in b:
        s.sort_order = v_int(b["order"], "Order", min_val=0, max_val=999)
    if "active" in b:
        s.active = 1 if b["active"] else 0
    await db.flush()
    _audit(db, uid, "social.update", link_id,
           {"from": old, "to": {"platform": s.platform, "active": bool(s.active)}},
           old_value={"active": old["active"]}, new_value={"active": bool(s.active)})
    await db.commit()
    await db.refresh(s)
    return out(s)


async def delete(db: AsyncSession, uid, link_id: str, reason: str | None = None) -> dict:
    s = await db.get(SocialLink, link_id)
    if not s:
        raise not_found("Social link not found")
    detail = {"platform": s.platform, "url": s.url}
    await db.delete(s)
    _audit(db, uid, "social.delete", link_id, detail, reason=reason)
    await db.commit()
    return {"ok": True}


async def reorder(db: AsyncSession, uid, ids) -> list[dict]:
    """Footer order: an explicit id list saves its index; links never carry data
    that anything else references, so this is a plain renumbering."""
    order = [str(x) for x in (ids if isinstance(ids, list) else [])]
    if not order:
        raise bad("Nothing to reorder")
    for i, link_id in enumerate(order):
        s = await db.get(SocialLink, link_id)
        if s:
            s.sort_order = i + 1
    await db.flush()
    _audit(db, uid, "social.reorder", None, {"order": order})
    await db.commit()
    return await list_all(db)
