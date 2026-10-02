"""Our People CMS (additional-requirements Phase B) — Python twin of
server/services/people.js.

The single source of truth for the people the platform presents: Founder, Main
Acharya, acharyas, Vedic scholars, jyotish experts, pandits, temple
representatives, advisors and the team. Nothing here is hard-coded content:
every row (Founder and Main Acharya included) is created, ordered, categorised,
published or hidden by an admin, and every write is audited. Categories are
reference data seeded by app.seed_people; people are ordinary rows. Deleting a
category is refused while people still use it, and deleting a person removes
their own gallery rows and stored artifacts because nothing else references
them.

Photo pipeline mirrors puja media: bytes arrive magic-byte verified from the
router, are written under uploads/media with a server-generated name, and
Pillow produces the 320px JPEG thumb + WebP pair. Public reads only ever see
active people in active categories.
"""
import json
import time
from pathlib import Path

from PIL import Image
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..models import AuditLog, PeopleCategory, Person, PersonPhoto
from ..serialize import people_category, person as s_person, person_card, person_photo
from ..util import (THUMB_SUFFIX, THUMB_WEBP_SUFFIX, WEBP_SUFFIX, bad, base_name,
                    not_found, rid, v_int, v_str, verify_upload)

settings = get_settings()
MEDIA_DIR = Path(settings.upload_dir) / "media"
MAX_PHOTOS = 12

EXPERTISE_MAX = 12
SOCIALS_MAX = 8


def _now_ms() -> int:
    return int(time.time() * 1000)


def _media_path(name: str) -> Path:
    """Path inside uploads/media; basename() defeats any traversal."""
    return MEDIA_DIR / Path(name).name


def _exists(p: Path) -> bool:
    return p.exists() and p.stat().st_size > 0


def _unlink(name: str | None) -> None:
    if not name:
        return
    try:
        _media_path(name).unlink()
    except OSError:
        pass  # already gone


def _unlink_artifacts(names) -> None:
    for n in names:
        _unlink(n)


def _audit(db: AsyncSession, uid, action: str, entity: str, entity_id, detail: dict | None = None,
           reason: str | None = None, old_value=None, new_value=None) -> None:
    db.add(AuditLog(actor_user_id=uid, actor_role="admin", action=action, entity=entity,
                    entity_id=entity_id,
                    detail=json.dumps(detail or {}),
                    old_value=json.dumps(old_value) if old_value is not None else None,
                    new_value=json.dumps(new_value) if new_value is not None else None,
                    reason=reason,
                    created_at=_now_ms()))


# --- photo variants (thumb + WebP pair), idempotent ---------------------------
def _variants(name: str) -> dict:
    out = {"thumb": "", "webp": "", "thumb_webp": ""}
    orig = _media_path(name)
    if not _exists(orig):
        return out
    base = base_name(name)
    thumb, webp, thumb_webp = base + THUMB_SUFFIX, base + WEBP_SUFFIX, base + THUMB_WEBP_SUFFIX
    try:
        im = Image.open(orig).convert("RGB")
        if not _exists(_media_path(thumb)):
            t = im.copy()
            t.thumbnail((320, 320))  # keeps the aspect ratio, unlike puja thumbs
            t.save(_media_path(thumb), "JPEG", quality=80)
        if not _exists(_media_path(webp)):
            im.save(_media_path(webp), "WEBP", quality=82)
        if _exists(_media_path(thumb)) and not _exists(_media_path(thumb_webp)):
            Image.open(_media_path(thumb)).convert("RGB").save(_media_path(thumb_webp), "WEBP", quality=80)
    except Exception as e:  # noqa: BLE001 — variants are best-effort, like Node's sharp path
        print(f"[people] variants {name} {e}")
    if _exists(_media_path(thumb)):
        out["thumb"] = thumb
    if _exists(_media_path(webp)):
        out["webp"] = webp
    if _exists(_media_path(thumb_webp)):
        out["thumb_webp"] = thumb_webp
    return out


def _store(data: bytes, claimed: str, prefix: str) -> tuple[str, str]:
    """Magic-byte verifies then writes under a fresh media name; returns
    (name, real_mime). Nothing is written when the content does not match."""
    real = verify_upload(data, claimed)
    ext = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[real]
    name = prefix + rid(10) + ext
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    _media_path(name).write_bytes(data)
    return name, real


# --- categories ---------------------------------------------------------------
async def get_category(db: AsyncSession, cid: str) -> PeopleCategory | None:
    return await db.get(PeopleCategory, cid)


async def list_categories(db: AsyncSession) -> list[dict]:
    rows = (await db.execute(select(PeopleCategory)
                             .order_by(PeopleCategory.sort_order, PeopleCategory.name))).scalars().all()
    return [people_category(c) for c in rows]


async def list_active_categories(db: AsyncSession) -> list[dict]:
    rows = (await db.execute(select(PeopleCategory).where(PeopleCategory.active == 1)
                             .order_by(PeopleCategory.sort_order, PeopleCategory.name))).scalars().all()
    return [people_category(c) for c in rows]


def _slug(raw, fallback: str) -> str:
    s = "".join(ch if ch.isalnum() or ch == "-" else "-" for ch in str(raw or "").strip().lower())
    s = s.strip("-")[:40]
    return s or fallback


async def create_category(db: AsyncSession, uid, b: dict) -> dict:
    b = b or {}
    name = v_str(b.get("name"), "Category name", max_len=80)
    cid = _slug(b.get("id"), "")
    if not cid:
        cid = "cat-" + rid(4)
    if await db.get(PeopleCategory, cid):
        cid = cid + "-" + rid(3)
    if b.get("order") is None:
        current = (await db.execute(select(func.coalesce(func.max(PeopleCategory.sort_order), 0)))).scalar_one()
        order = int(current) + 1
    else:
        order = v_int(b.get("order"), "Order", min_val=0, max_val=999)
    db.add(PeopleCategory(id=cid, name=name, sort_order=order, active=1, created=_now_ms()))
    await db.flush()
    _audit(db, uid, "people.category_create", "people_category", cid, {"name": name, "order": order})
    await db.commit()
    return people_category(await db.get(PeopleCategory, cid))


async def update_category(db: AsyncSession, uid, cid: str, b: dict) -> dict:
    c = await db.get(PeopleCategory, cid)
    if not c:
        raise not_found("Category not found")
    b = b or {}
    old = {"name": c.name, "order": c.sort_order, "active": bool(c.active)}
    if "name" in b:
        c.name = v_str(b["name"], "Category name", max_len=80)
    if "order" in b:
        c.sort_order = v_int(b["order"], "Order", min_val=0, max_val=999)
    if "active" in b:
        c.active = 1 if b["active"] else 0
    await db.flush()
    _audit(db, uid, "people.category_update", "people_category", cid,
           {"from": old, "to": {"name": c.name, "order": c.sort_order, "active": bool(c.active)}},
           old_value={"active": old["active"]}, new_value={"active": bool(c.active)})
    await db.commit()
    await db.refresh(c)
    return people_category(c)


async def delete_category(db: AsyncSession, uid, cid: str, reason: str | None = None) -> dict:
    c = await db.get(PeopleCategory, cid)
    if not c:
        raise not_found("Category not found")
    used = (await db.execute(select(func.count()).select_from(Person)
                             .where(Person.category_id == cid))).scalar_one()
    if used:
        raise bad("People are still listed under this category. Move them first, or deactivate the category.")
    name = c.name
    await db.delete(c)
    _audit(db, uid, "people.category_delete", "people_category", cid, {"name": name}, reason=reason)
    await db.commit()
    return {"ok": True}


async def reorder_categories(db: AsyncSession, uid, ids) -> list[dict]:
    order = [str(x) for x in (ids if isinstance(ids, list) else [])]
    if not order:
        raise bad("Nothing to reorder")
    for i, cid in enumerate(order):
        c = await db.get(PeopleCategory, cid)
        if c:
            c.sort_order = i + 1
    await db.flush()
    _audit(db, uid, "people.category_reorder", "people_category", None, {"order": order})
    await db.commit()
    return await list_categories(db)


# --- people -------------------------------------------------------------------
def _clean_expertise(x) -> list[str]:
    return [str(s).strip()[:80] for s in (x if isinstance(x, list) else []) if str(s).strip()][:EXPERTISE_MAX]


def _clean_socials(x) -> list[dict]:
    out = []
    for s in (x if isinstance(x, list) else []):
        s = s or {}
        platform = str(s.get("platform") or "").strip()[:30]
        url = str(s.get("url") or "").strip()[:300]
        if platform and url.lower().startswith(("http://", "https://")):
            out.append({"platform": platform, "url": url})
    return out[:SOCIALS_MAX]


def _clean_video(x) -> str:
    u = str(x or "").strip()[:300]
    if u and not u.lower().startswith(("http://", "https://")):
        raise bad("Video link must start with http:// or https://")
    return u


async def _category_id(db: AsyncSession, raw) -> str | None:
    cid = str(raw or "").strip()
    if not cid:
        return None
    if not await db.get(PeopleCategory, cid):
        raise bad("Choose a valid category")
    return cid


def _exp(x) -> int:
    return v_int(0 if x in (None, "") else x, "Years of experience", min_val=0, max_val=80)


async def get_person(db: AsyncSession, pid: str) -> Person | None:
    return await db.get(Person, pid)


async def create_person(db: AsyncSession, uid, b: dict) -> dict:
    b = b or {}
    name = v_str(b.get("name"), "Name", max_len=120)
    pid = "per" + rid(5)
    now = _now_ms()
    p = Person(id=pid, name=name,
               designation=v_str(b.get("designation"), "Designation", max_len=120, optional=True),
               category_id=await _category_id(db, b.get("categoryId")),
               city=v_str(b.get("city"), "City", max_len=80, optional=True),
               country=v_str(b.get("country"), "Country", max_len=80, optional=True),
               experience=_exp(b.get("exp")),
               qualifications=v_str(b.get("quals"), "Qualifications", max_len=300, optional=True),
               expertise=json.dumps(_clean_expertise(b.get("expertise"))),
               intro=v_str(b.get("intro"), "Introduction", max_len=300, optional=True),
               bio=v_str(b.get("bio"), "Story", max_len=4000, optional=True),
               background=v_str(b.get("background"), "Background", max_len=2000, optional=True),
               sanatan_work=v_str(b.get("sanatanWork"), "Sanatan work", max_len=2000, optional=True),
               video_url=_clean_video(b.get("video")),
               socials=json.dumps(_clean_socials(b.get("socials"))),
               sort_order=0 if b.get("order") is None else v_int(b.get("order"), "Order", min_val=0, max_val=999),
               active=1 if b.get("active") is None else (1 if b.get("active") else 0),
               created=now, updated=now)
    db.add(p)
    await db.flush()
    _audit(db, uid, "people.create", "person", pid, {"name": name, "categoryId": p.category_id})
    await db.commit()
    return await _row(db, pid)


async def _row(db: AsyncSession, pid: str) -> dict:
    """One admin-shaped person including the gallery, so write responses keep the
    admin Photos dialog accurate without a second round-trip."""
    p = await db.get(Person, pid)
    c = await db.get(PeopleCategory, p.category_id) if p.category_id else None
    p.category_name = c.name if c else ""
    photos = (await db.execute(select(PersonPhoto).where(PersonPhoto.person_id == pid)
                               .order_by(PersonPhoto.sort_order, PersonPhoto.created))).scalars().all()
    return {**s_person(p, admin=True), "photos": [person_photo(x) for x in photos]}


async def update_person(db: AsyncSession, uid, pid: str, b: dict) -> dict:
    p = await db.get(Person, pid)
    if not p:
        raise not_found("Person not found")
    b = b or {}
    old = {"name": p.name, "categoryId": p.category_id, "active": bool(p.active)}
    if "name" in b:
        p.name = v_str(b["name"], "Name", max_len=120)
    if "designation" in b:
        p.designation = v_str(b["designation"], "Designation", max_len=120, optional=True)
    if "categoryId" in b:
        p.category_id = await _category_id(db, b["categoryId"])
    if "city" in b:
        p.city = v_str(b["city"], "City", max_len=80, optional=True)
    if "country" in b:
        p.country = v_str(b["country"], "Country", max_len=80, optional=True)
    if "exp" in b:
        p.experience = _exp(b["exp"])
    if "quals" in b:
        p.qualifications = v_str(b["quals"], "Qualifications", max_len=300, optional=True)
    if "expertise" in b:
        p.expertise = json.dumps(_clean_expertise(b["expertise"]))
    if "intro" in b:
        p.intro = v_str(b["intro"], "Introduction", max_len=300, optional=True)
    if "bio" in b:
        p.bio = v_str(b["bio"], "Story", max_len=4000, optional=True)
    if "background" in b:
        p.background = v_str(b["background"], "Background", max_len=2000, optional=True)
    if "sanatanWork" in b:
        p.sanatan_work = v_str(b["sanatanWork"], "Sanatan work", max_len=2000, optional=True)
    if "video" in b:
        p.video_url = _clean_video(b["video"])
    if "socials" in b:
        p.socials = json.dumps(_clean_socials(b["socials"]))
    if "order" in b:
        p.sort_order = v_int(b["order"], "Order", min_val=0, max_val=999)
    if "active" in b:
        p.active = 1 if b["active"] else 0
    p.updated = _now_ms()
    await db.flush()
    _audit(db, uid, "people.update", "person", pid,
           {"from": old, "to": {"name": p.name, "categoryId": p.category_id, "active": bool(p.active)}},
           old_value={"active": old["active"]}, new_value={"active": bool(p.active)})
    await db.commit()
    return await _row(db, pid)


async def delete_person(db: AsyncSession, uid, pid: str, reason: str | None = None) -> dict:
    p = await db.get(Person, pid)
    if not p:
        raise not_found("Person not found")
    photos = (await db.execute(select(PersonPhoto).where(PersonPhoto.person_id == pid))).scalars().all()
    files = [p.photo_file, p.photo_thumb, p.photo_webp, p.photo_thumb_webp]
    for ph in photos:
        files += [ph.filename, ph.thumb, ph.webp, ph.thumb_webp]
    name = p.name
    await db.delete(p)
    for ph in photos:
        await db.delete(ph)
    _audit(db, uid, "people.delete", "person", pid, {"name": name, "photos": len(photos)}, reason=reason)
    await db.commit()
    _unlink_artifacts(files)
    return {"ok": True}


# --- photos -------------------------------------------------------------------
async def set_photo(db: AsyncSession, uid, pid: str, data: bytes, claimed: str, original_name: str) -> dict:
    p = await db.get(Person, pid)
    if not p:
        raise not_found("Person not found")
    name, _real = _store(data, claimed, "people-")
    vt = _variants(name)
    old = [p.photo_file, p.photo_thumb, p.photo_webp, p.photo_thumb_webp]
    p.photo_file = name
    p.photo_thumb = vt["thumb"] or None
    p.photo_webp = vt["webp"] or None
    p.photo_thumb_webp = vt["thumb_webp"] or None
    p.updated = _now_ms()
    await db.flush()
    _audit(db, uid, "people.photo_set", "person", pid, {"file": name})
    await db.commit()
    _unlink_artifacts(old)
    return await _row(db, pid)


async def clear_photo(db: AsyncSession, uid, pid: str, reason: str | None = None) -> dict:
    p = await db.get(Person, pid)
    if not p:
        raise not_found("Person not found")
    old = [p.photo_file, p.photo_thumb, p.photo_webp, p.photo_thumb_webp]
    p.photo_file = p.photo_thumb = p.photo_webp = p.photo_thumb_webp = None
    p.updated = _now_ms()
    await db.flush()
    _audit(db, uid, "people.photo_clear", "person", pid, {}, reason=reason)
    await db.commit()
    _unlink_artifacts(old)
    return await _row(db, pid)


async def add_gallery_photo(db: AsyncSession, uid, pid: str, data: bytes, claimed: str,
                            original_name: str, caption: str = "") -> dict:
    p = await db.get(Person, pid)
    if not p:
        raise not_found("Person not found")
    count = (await db.execute(select(func.count()).select_from(PersonPhoto)
                              .where(PersonPhoto.person_id == pid))).scalar_one()
    if count >= MAX_PHOTOS:
        raise bad("Photo limit reached for this profile")
    name, _real = _store(data, claimed, "peoplep-")
    vt = _variants(name)
    photo_id = "pp" + rid(5)
    order = (await db.execute(select(func.coalesce(func.max(PersonPhoto.sort_order), 0))
                              .where(PersonPhoto.person_id == pid))).scalar_one()
    ph = PersonPhoto(id=photo_id, person_id=pid, filename=name, thumb=vt["thumb"] or None,
                     webp=vt["webp"] or None, thumb_webp=vt["thumb_webp"] or None,
                     caption=v_str(caption, "Caption", max_len=200, optional=True),
                     sort_order=int(order) + 1, created=_now_ms())
    db.add(ph)
    await db.flush()
    _audit(db, uid, "people.photo_add", "person", pid, {"photoId": photo_id, "file": name})
    await db.commit()
    await db.refresh(ph)
    return person_photo(ph)


async def delete_gallery_photo(db: AsyncSession, uid, photo_id: str, reason: str | None = None) -> dict:
    ph = await db.get(PersonPhoto, photo_id)
    if not ph:
        raise not_found("Photo not found")
    person_id = ph.person_id
    files = [ph.filename, ph.thumb, ph.webp, ph.thumb_webp]
    await db.delete(ph)
    _audit(db, uid, "people.photo_delete", "person", person_id, {"photoId": photo_id}, reason=reason)
    await db.commit()
    _unlink_artifacts(files)
    return {"ok": True}


# --- public reads -------------------------------------------------------------
async def list_all(db: AsyncSession) -> list[dict]:
    """Every person (inactive included) with the category name and their gallery
    (the admin Photos dialog manages it)."""
    rows = (await db.execute(
        select(Person, PeopleCategory.name)
        .outerjoin(PeopleCategory, PeopleCategory.id == Person.category_id)
        .order_by(func.coalesce(PeopleCategory.sort_order, 999), Person.sort_order,
                  func.lower(Person.name)))).all()
    photos: dict[str, list] = {}
    for ph in (await db.execute(select(PersonPhoto)
                                .order_by(PersonPhoto.sort_order, PersonPhoto.created))).scalars().all():
        photos.setdefault(ph.person_id, []).append(person_photo(ph))
    out = []
    for p, cname in rows:
        p.category_name = cname or ""
        out.append({**s_person(p, admin=True), "photos": photos.get(p.id, [])})
    return out


async def list_active(db: AsyncSession) -> list[dict]:
    rows = (await db.execute(
        select(Person).join(PeopleCategory, PeopleCategory.id == Person.category_id)
        .where(Person.active == 1, PeopleCategory.active == 1)
        .order_by(PeopleCategory.sort_order, Person.sort_order, func.lower(Person.name)))).scalars().all()
    return [person_card(p) for p in rows]


async def profile(db: AsyncSession, pid: str) -> dict | None:
    p = await db.get(Person, str(pid or ""))
    if not p or not p.active:
        return None
    if p.category_id:
        c = await db.get(PeopleCategory, p.category_id)
        if not c or not c.active:
            return None
    photos = (await db.execute(select(PersonPhoto).where(PersonPhoto.person_id == p.id)
                               .order_by(PersonPhoto.sort_order, PersonPhoto.created))).scalars().all()
    out = s_person(p)
    out["photos"] = [person_photo(x) for x in photos]
    return out
