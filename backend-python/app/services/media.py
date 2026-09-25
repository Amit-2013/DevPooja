"""Puja media service — the Python port of server/services/pujaMedia.js and
mediaVariants.js. One store, three consumers:

- admin: full management (upload, approve/reject, publish/unpublish, delete)
- pandit: uploads only for their own assigned bookings (ownership is verified
  server-side); uploads start PENDING_ADMIN_REVIEW and are never public until
  the admin approves AND publishes. Alt text is required (spec).
- public/customers: only APPROVED + PUBLISHED photos ever leave the server.

Delete completeness (ported fix): removing a photo removes EVERY stored
artifact — original + JPEG thumb + full WebP + thumb WebP — with a stale-column
fallback that derives variant names when the webp/thumb_webp columns are empty.
"""
import json
import time
from pathlib import Path

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from PIL import Image

from ..config import get_settings
from ..models import AuditLog, Booking, Pandit, Puja, PujaMedia
from ..util import (MEDIA_MIME, THUMB_SUFFIX, THUMB_WEBP_SUFFIX, WEBP_SUFFIX,
                    bad, base_name, forbidden, not_found, rid, verify_upload)

settings = get_settings()
MEDIA_DIR = Path(settings.upload_dir) / "media"
MAX_PHOTOS_PER_PUJA = 24
PUBLIC_CATEGORIES = ("puja", "ritual", "temple", "seva")


def media_path(name: str) -> Path:
    """Path inside uploads/media; the basename() call defeats any traversal."""
    return MEDIA_DIR / Path(name).name


def out(r: PujaMedia) -> dict:
    """API payload — same shape as the Node serializer."""
    return {
        "id": r.id, "pujaId": r.puja_id, "bookingId": r.booking_id, "panditId": r.pandit_id,
        "uploadedBy": r.uploaded_by, "origName": r.orig_name, "mime": r.mime, "size": r.size,
        "status": r.status, "isPrimary": bool(r.is_primary), "isPublished": bool(r.is_published),
        "displayOrder": r.display_order,
        "url": "/media/" + r.filename, "thumb": "/media/" + r.thumb if r.thumb else "",
        "webp": "/media/" + r.webp if r.webp else "",
        "thumbWebp": "/media/" + r.thumb_webp if r.thumb_webp else "",
        "source": r.source, "license": r.license, "credit": r.credit,
        "creator": r.creator, "creditUrl": r.credit_url,
        "altText": r.alt_text, "category": r.category, "rejectReason": r.reject_reason,
        "createdAt": r.created_at,
    }


# --- variants (Pillow port of mediaVariants.js) ------------------------------
async def ensure_variants(db: AsyncSession, r: PujaMedia) -> PujaMedia:
    """Generate the full WebP (and thumb WebP when a JPEG thumb exists) if missing.
    Idempotent: existing files are never regenerated."""
    try:
        if r.mime not in MEDIA_MIME:
            return r
        orig = media_path(r.filename)
        if not orig.exists():
            return r
        updates = {}
        webp_name = base_name(r.filename) + WEBP_SUFFIX
        webp_path = media_path(webp_name)
        if not webp_path.exists():
            Image.open(orig).convert("RGB").save(webp_path, "WEBP", quality=82)
        updates["webp"] = webp_name
        if r.thumb:
            thumb_webp_name = base_name(r.thumb) + THUMB_WEBP_SUFFIX
            tw_path = media_path(thumb_webp_name)
            if not tw_path.exists():
                Image.open(media_path(r.thumb)).convert("RGB").save(tw_path, "WEBP", quality=80)
            updates["thumb_webp"] = thumb_webp_name
        for col, val in updates.items():
            if getattr(r, col) != val:
                setattr(r, col, val)
        await db.flush()
        return r
    except Exception as e:  # noqa: BLE001 — variants are best-effort, like Node's repairAll
        print(f"[mediaVariants] {r.id} {e}")
        return r


# --- gallery (public) ---------------------------------------------------------
async def public_for_puja(db: AsyncSession, puja_id: str, *, limit: int = 12,
                          offset: int = 0, category: str | None = None) -> dict:
    """Approved AND published only, primary first. Paginated like the Node route."""
    limit = max(1, min(48, int(limit or 12)))
    offset = max(0, int(offset or 0))
    conds = [PujaMedia.puja_id == puja_id, PujaMedia.status == "APPROVED", PujaMedia.is_published == 1]
    if category and category in PUBLIC_CATEGORIES:
        conds.append(PujaMedia.category == category)
    rows = (await db.execute(
        select(PujaMedia).where(*conds)
        .order_by(PujaMedia.is_primary.desc(), PujaMedia.display_order, PujaMedia.created_at)
        .limit(limit + 1).offset(offset))).scalars().all()
    total = (await db.execute(select(func.count()).select_from(PujaMedia).where(*conds))).scalar_one()
    photos = [out(r) for r in rows[:limit]]
    return {"photos": photos, "total": total, "limit": limit, "offset": offset,
            "nextOffset": offset + limit if offset + limit < total else None}


# --- admin views --------------------------------------------------------------
async def admin_list(db: AsyncSession, *, status: str | None = None,
                     source: str | None = None, limit: int = 300) -> list[dict]:
    q = select(PujaMedia).order_by(
        PujaMedia.status == "APPROVED", PujaMedia.status == "REJECTED",
        PujaMedia.created_at.desc()).limit(min(500, max(1, int(limit or 300))))
    if status in ("PENDING_ADMIN_REVIEW", "APPROVED", "REJECTED"):
        q = q.where(PujaMedia.status == status)
    if source in ("seeded", "admin", "pandit"):
        q = q.where(PujaMedia.source == source)
    return [out(r) for r in (await db.execute(q)).scalars().all()]


# --- pandit upload -------------------------------------------------------------
async def pandit_upload(db: AsyncSession, *, pid: str, uid: str | None, booking_id: str,
                        files: list[tuple[bytes, str, str]], alt_text: str) -> list[dict]:
    """files: [(data, claimed_mime, original_name), ...] — every file is magic-byte
    verified BEFORE this call. Booking must belong to THIS pandit."""
    b = (await db.execute(select(Booking).where(Booking.id == (booking_id or "")))).scalar_one_or_none()
    if not b:
        raise not_found("Booking not found")
    if b.pandit_id != pid:
        raise forbidden("You can only upload photos for your own assigned bookings")
    if not str(alt_text or "").strip():
        raise bad("Describe the photo (alt text is required)")
    count = (await db.execute(select(func.count()).select_from(PujaMedia).where(PujaMedia.puja_id == b.puja_id))).scalar_one()
    inserted = []
    for data, claimed, orig_name in files:
        real = verify_upload(data, claimed)
        if count >= MAX_PHOTOS_PER_PUJA:
            continue  # over the limit: file is never written
        ext = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[real]
        filename = rid(8) + ext
        MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        (MEDIA_DIR / filename).write_bytes(data)
        m = PujaMedia(
            id="pm" + rid(5), puja_id=b.puja_id, booking_id=b.id, pandit_id=pid,
            uploaded_by=uid, orig_name=str(orig_name or "")[:120], filename=filename,
            mime=real, size=len(data), status="PENDING_ADMIN_REVIEW",
            is_primary=0, is_published=0, display_order=0, created_at=int(time.time() * 1000),
            source="pandit", alt_text=str(alt_text).strip()[:160], category="seva")
        db.add(m)
        inserted.append(m)
        count += 1
    if not inserted:
        raise bad("Photo limit reached for this puja")
    await db.flush()
    db.add(AuditLog(actor_user_id=uid, actor_role="pandit", action="media.pandit_upload",
                    entity="puja_media", entity_id=inserted[0].id,
                    detail=json.dumps({"count": len(inserted), "bookingId": b.id, "pujaId": b.puja_id}),
                    created_at=int(time.time() * 1000)))
    for m in inserted:
        await ensure_variants(db, m)
    return [out(m) for m in inserted]


# --- admin upload ---------------------------------------------------------------
async def admin_upload(db: AsyncSession, *, uid: str | None, puja_id: str,
                       files: list[tuple[bytes, str, str]], alt_text: str = "",
                       category: str = "puja", published: bool = True,
                       make_primary: bool = False) -> list[dict]:
    count = (await db.execute(select(func.count()).select_from(PujaMedia).where(PujaMedia.puja_id == puja_id))).scalar_one()
    first = count == 0
    inserted = []
    for data, claimed, orig_name in files:
        real = verify_upload(data, claimed)
        if count >= MAX_PHOTOS_PER_PUJA:
            continue
        ext = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[real]
        filename = rid(8) + ext
        MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        (MEDIA_DIR / filename).write_bytes(data)
        primary = (make_primary or first) and not inserted
        m = PujaMedia(
            id="pm" + rid(5), puja_id=puja_id, uploaded_by=uid,
            orig_name=str(orig_name or "")[:120], filename=filename,
            mime=real, size=len(data), status="APPROVED",
            is_primary=1 if primary else 0, is_published=1 if published else 0,
            display_order=0, created_at=int(time.time() * 1000),
            source="admin", alt_text=str(alt_text or orig_name or "Puja photo")[:160],
            category=category if category in PUBLIC_CATEGORIES else "puja")
        if primary:
            await db.execute(update(PujaMedia).where(
                PujaMedia.puja_id == puja_id, PujaMedia.id != m.id).values(is_primary=0))
        db.add(m)
        inserted.append(m)
        count += 1
    if not inserted:
        raise bad("Photo limit reached for this puja")
    await db.flush()
    db.add(AuditLog(actor_user_id=uid, actor_role="admin", action="media.admin_upload",
                    entity="puja_media", entity_id=inserted[0].id,
                    detail=json.dumps({"count": len(inserted), "pujaId": puja_id}),
                    created_at=int(time.time() * 1000)))
    for m in inserted:
        await ensure_variants(db, m)
    return [out(m) for m in inserted]


# --- moderation -------------------------------------------------------------------
async def moderate(db: AsyncSession, *, uid: str, id: str, status: str | None = None,
                   published: bool | None = None, primary: bool | None = None,
                   reject_reason: str = "") -> dict:
    r = (await db.execute(select(PujaMedia).where(PujaMedia.id == id))).scalar_one_or_none()
    if not r:
        raise not_found("Photo not found")
    now = int(time.time() * 1000)
    if status is not None:
        if status not in ("PENDING_ADMIN_REVIEW", "APPROVED", "REJECTED"):
            raise bad("Unknown status")
        r.status = status
        if status == "REJECTED":
            r.is_published = 0  # rejected photos are never public
            r.reject_reason = str(reject_reason or "Does not meet the photo guidelines")[:200]
        elif status == "APPROVED":
            r.reject_reason = ""
    if published is not None:
        if published and r.status != "APPROVED":
            raise bad("Only approved photos can be published")
        if published and r.reject_reason:
            r.reject_reason = ""
        r.is_published = 1 if published else 0
    if primary:
        await db.execute(update(PujaMedia).where(PujaMedia.puja_id == r.puja_id).values(is_primary=0))
        r.is_primary = 1
        if published is None and r.status == "APPROVED":
            r.is_published = 1
    r.updated_at = now
    await db.flush()
    db.add(AuditLog(actor_user_id=uid, actor_role="admin", action="media.moderate",
                    entity="puja_media", entity_id=id,
                    detail=json.dumps({"status": status or r.status, "published": published,
                                       "primary": bool(primary)}),
                    created_at=now))
    return out(r)


async def bulk(db: AsyncSession, *, uid: str, ids: list[str], op: str) -> dict:
    """Bulk moderation; returns per-id results like the Node service."""
    results = []
    for id in (ids or [])[:200]:
        try:
            if op == "delete":
                await remove(db, uid=uid, role="admin", pid=None, id=id)
                results.append({"id": id, "ok": True})
                continue
            patch = {"approve": dict(status="APPROVED"),
                     "reject": dict(status="REJECTED"),
                     "publish": dict(published=True),
                     "unpublish": dict(published=False)}.get(op)
            if patch is None:
                raise bad("Unknown bulk operation")
            await moderate(db, uid=uid, id=id, **patch)
            results.append({"id": id, "ok": True})
        except Exception as e:  # noqa: BLE001 — per-id error reporting
            results.append({"id": id, "ok": False, "error": str(getattr(e, "detail", e))})
    return {"results": results, "changed": sum(1 for r in results if r["ok"])}


# --- delete: every artifact goes ---------------------------------------------------
async def remove(db: AsyncSession, *, uid: str, role: str, pid: str | None, id: str) -> dict:
    r = (await db.execute(select(PujaMedia).where(PujaMedia.id == id))).scalar_one_or_none()
    if not r:
        raise not_found("Photo not found")
    if role == "pandit":
        if r.pandit_id != pid:
            raise forbidden("You can only manage your own uploads")
        if r.status != "PENDING_ADMIN_REVIEW":
            raise forbidden("Approved photos are managed by the admin")
    elif role != "admin":
        raise forbidden("Not allowed")

    names = set()
    if r.filename:
        names.add(Path(r.filename).name)
    if r.thumb:
        names.add(Path(r.thumb).name)
    if r.webp:
        names.add(Path(r.webp).name)
    if r.thumb_webp:
        names.add(Path(r.thumb_webp).name)
    base = Path(r.filename or "").name
    if base:  # stale-column fallback: derive names when columns are empty
        if not r.webp:
            names.add(base_name(base) + WEBP_SUFFIX)
        if not r.thumb_webp and r.thumb:
            names.add(base_name(Path(r.thumb).name) + THUMB_WEBP_SUFFIX)
    for name in names:
        try:
            (MEDIA_DIR / name).unlink(missing_ok=True)
        except OSError:
            pass
    await db.execute(PujaMedia.__table__.delete().where(PujaMedia.id == id))
    db.add(AuditLog(actor_user_id=uid, actor_role=role, action="media.delete",
                    entity="puja_media", entity_id=id,
                    detail=json.dumps({"pujaId": r.puja_id, "by": role, "files": len(names)}),
                    created_at=int(time.time() * 1000)))
    await db.flush()
    return {"ok": True}


# --- secure download -----------------------------------------------------------------
async def file_for(db: AsyncSession, id: str, auth: dict | None) -> dict:
    """Streams the file for a media id with the Node role rules:
    admin: any · pandit: own uploads · customer/anonymous: APPROVED+PUBLISHED only."""
    r = (await db.execute(select(PujaMedia).where(PujaMedia.id == str(id or "")))).scalar_one_or_none()
    if not r:
        raise not_found("Photo not found")
    public = r.status == "APPROVED" and r.is_published == 1
    if auth and auth.get("role") == "pandit" and r.pandit_id != auth.get("pid") and not public:
        raise forbidden("Not allowed")
    if (not auth or auth.get("role") == "customer") and not public:
        raise not_found("Photo not found")
    f = media_path(r.filename)
    if not f.exists():
        raise not_found("File missing")
    return {"file": f, "mime": r.mime, "name": r.orig_name or r.filename}


# --- thumbnails for seeded imports ----------------------------------------------------
def make_thumb(filename: str) -> str:
    """320px JPEG thumb; returns the stored name (used by the seed/swap importer)."""
    thumb_name = base_name(filename) + THUMB_SUFFIX
    src = media_path(filename)
    Image.open(src).convert("RGB").resize((320, 320)).save(MEDIA_DIR / thumb_name, "JPEG", quality=80)
    return thumb_name
