"""Photo + Video Gallery (additional-requirements Phase D) — Python twin of
server/services/gallery.js.

The single source of truth for the public gallery: albums, uploaded photos and
YouTube videos are admin-managed rows, never hard-coded markup.

Decisions (mirrored by migration 032):
- Albums group photos AND videos. Deleting an album never deletes media — its
  rows become un-albumed (album_id None) and stay in the public tabs, because
  curated images must only disappear through an explicit, audited delete.
- Photos mirror the people-photo pipeline: magic-byte verification in the
  service, a server-generated name under uploads/media and Pillow-produced
  320px JPEG thumb + WebP pair, plus PHOTO-MEDIA-SPEC-style provenance
  (license/credit/credit_url) so copied seed photos keep their attribution.
- Videos are YouTube links (validated on write); the embed id is derived from
  the URL on read, so hosting video files is never needed.
- Public reads only ever see active rows whose album is active.

Every write is audited through the same AuditLog helper the people CMS uses.
"""
import json
import time
from pathlib import Path

from PIL import Image
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..models import AuditLog, GalleryAlbum, GalleryPhoto, GalleryVideo
from ..serialize import (gallery_album as s_album, gallery_photo as s_photo,
                         gallery_video as s_video)
from ..util import (THUMB_SUFFIX, THUMB_WEBP_SUFFIX, WEBP_SUFFIX, bad, base_name,
                    not_found, rid, v_int, v_str, verify_upload)

settings = get_settings()
MEDIA_DIR = Path(settings.upload_dir) / "media"
PAGE_MAX = 48

IMAGE_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _media_path(name) -> Path:
    """Path inside uploads/media; basename() defeats any traversal."""
    return MEDIA_DIR / Path(name).name


def _exists(p: Path) -> bool:
    return p.exists() and p.stat().st_size > 0


def _unlink(name) -> None:
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


def _flag(x) -> bool:
    """Form fields arrive as strings: 'false'/'0' must mean off, never truthy."""
    if x is None:
        return True
    if isinstance(x, bool):
        return x
    return str(x).strip().lower() not in ("false", "0", "")


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
            t.thumbnail((320, 320))  # keeps the aspect ratio, like the people photos
            t.save(_media_path(thumb), "JPEG", quality=80)
        if not _exists(_media_path(webp)):
            im.save(_media_path(webp), "WEBP", quality=82)
        if _exists(_media_path(thumb)) and not _exists(_media_path(thumb_webp)):
            Image.open(_media_path(thumb)).convert("RGB").save(_media_path(thumb_webp), "WEBP", quality=80)
    except Exception as e:  # noqa: BLE001 — variants are best-effort, like Node's sharp path
        print(f"[gallery] variants {name} {e}")
    if _exists(_media_path(thumb)):
        out["thumb"] = thumb
    if _exists(_media_path(webp)):
        out["webp"] = webp
    if _exists(_media_path(thumb_webp)):
        out["thumb_webp"] = thumb_webp
    return out


def _store(data: bytes, claimed: str, prefix: str) -> tuple[str, str]:
    """Magic-byte verifies an IMAGE, then writes it under a fresh media name.
    Videos and PDFs are rejected here — gallery photos are raster images only."""
    if claimed and claimed not in IMAGE_EXT:
        raise bad("Gallery photos must be JPG, PNG or WEBP images")
    real = verify_upload(data, claimed)
    if real not in IMAGE_EXT:
        raise bad("Gallery photos must be JPG, PNG or WEBP images")
    name = prefix + rid(10) + IMAGE_EXT[real]
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    _media_path(name).write_bytes(data)
    return name, real


# --- albums -------------------------------------------------------------------
async def get_album(db: AsyncSession, aid: str) -> GalleryAlbum | None:
    return await db.get(GalleryAlbum, str(aid or ""))


async def _album_id(db: AsyncSession, raw) -> str | None:
    cid = str(raw if raw is not None else "").strip()
    if not cid:
        return None
    if not await db.get(GalleryAlbum, cid):
        raise bad("Choose a valid album")
    return cid


async def _with_meta(db: AsyncSession, a: GalleryAlbum, *, admin: bool = False) -> dict:
    """Counts + cover honour the caller's visibility: admin rows count every
    photo/video, public reads count active rows inside an active album."""
    photo_q = select(func.count()).select_from(GalleryPhoto).where(GalleryPhoto.album_id == a.id)
    video_q = select(func.count()).select_from(GalleryVideo).where(GalleryVideo.album_id == a.id)
    if not admin:
        photo_q = photo_q.where(GalleryPhoto.active == 1)
        video_q = video_q.where(GalleryVideo.active == 1)
    photo_count = (await db.execute(photo_q)).scalar_one()
    video_count = (await db.execute(video_q)).scalar_one()
    cover_q = select(GalleryPhoto).where(GalleryPhoto.album_id == a.id)
    if not admin:
        cover_q = cover_q.where(GalleryPhoto.active == 1)
    cover = (await db.execute(cover_q.order_by(GalleryPhoto.sort_order, GalleryPhoto.created)
                              .limit(1))).scalars().first()
    out = s_album(a)
    out["photos"] = int(photo_count)
    out["videos"] = int(video_count)
    if cover:
        out["cover"] = "/media/" + cover.filename
        out["coverThumb"] = "/media/" + cover.thumb if cover.thumb else ""
        out["coverWebp"] = "/media/" + cover.webp if cover.webp else ""
        out["coverThumbWebp"] = "/media/" + cover.thumb_webp if cover.thumb_webp else ""
    return out


async def list_albums(db: AsyncSession) -> list[dict]:
    rows = (await db.execute(select(GalleryAlbum)
                             .order_by(GalleryAlbum.sort_order, func.lower(GalleryAlbum.name)))).scalars().all()
    return [await _with_meta(db, a, admin=True) for a in rows]


async def list_active_albums(db: AsyncSession) -> list[dict]:
    rows = (await db.execute(select(GalleryAlbum).where(GalleryAlbum.active == 1)
                             .order_by(GalleryAlbum.sort_order, func.lower(GalleryAlbum.name)))).scalars().all()
    return [await _with_meta(db, a) for a in rows]


async def create_album(db: AsyncSession, uid, b: dict) -> dict:
    b = b or {}
    name = v_str(b.get("name"), "Album name", max_len=80)
    aid = "alb" + rid(5)
    if b.get("order") is None:
        order = int((await db.execute(select(func.coalesce(func.max(GalleryAlbum.sort_order), 0)))).scalar_one()) + 1
    else:
        order = v_int(b.get("order"), "Order", min_val=0, max_val=999)
    now = _now_ms()
    a = GalleryAlbum(id=aid, name=name,
                     description=v_str(b.get("description"), "Description", max_len=500, optional=True),
                     sort_order=order, active=1 if b.get("active") is None or _flag(b.get("active")) else 0,
                     created=now, updated=now)
    db.add(a)
    await db.flush()
    _audit(db, uid, "gallery.album_create", "gallery_album", aid, {"name": name, "order": order})
    await db.commit()
    await db.refresh(a)
    return await _with_meta(db, a, admin=True)


async def update_album(db: AsyncSession, uid, aid: str, b: dict) -> dict:
    a = await get_album(db, aid)
    if not a:
        raise not_found("Album not found")
    b = b or {}
    old = {"name": a.name, "order": a.sort_order, "active": bool(a.active)}
    if "name" in b:
        a.name = v_str(b["name"], "Album name", max_len=80)
    if "description" in b:
        a.description = v_str(b["description"], "Description", max_len=500, optional=True)
    if "order" in b:
        a.sort_order = v_int(b["order"], "Order", min_val=0, max_val=999)
    if "active" in b:
        a.active = 1 if _flag(b["active"]) else 0
    a.updated = _now_ms()
    await db.flush()
    _audit(db, uid, "gallery.album_update", "gallery_album", aid,
           {"from": old, "to": {"name": a.name, "order": a.sort_order, "active": bool(a.active)}},
           old_value={"active": old["active"]}, new_value={"active": bool(a.active)})
    await db.commit()
    await db.refresh(a)
    return await _with_meta(db, a, admin=True)


async def delete_album(db: AsyncSession, uid, aid: str, reason: str | None = None) -> dict:
    """Delete the grouping only: photos and videos keep existing as un-albumed
    rows (the migration documents this). The media survives a mistake."""
    a = await get_album(db, aid)
    if not a:
        raise not_found("Album not found")
    photo_count = int((await db.execute(select(func.count()).select_from(GalleryPhoto)
                                        .where(GalleryPhoto.album_id == aid))).scalar_one())
    video_count = int((await db.execute(select(func.count()).select_from(GalleryVideo)
                                        .where(GalleryVideo.album_id == aid))).scalar_one())
    now = _now_ms()
    for ph in (await db.execute(select(GalleryPhoto).where(GalleryPhoto.album_id == aid))).scalars().all():
        ph.album_id = None
        ph.updated = now
    for vd in (await db.execute(select(GalleryVideo).where(GalleryVideo.album_id == aid))).scalars().all():
        vd.album_id = None
        vd.updated = now
    await db.delete(a)
    _audit(db, uid, "gallery.album_delete", "gallery_album", aid,
           {"name": a.name, "photosMovedOut": photo_count, "videosMovedOut": video_count}, reason=reason)
    await db.commit()
    return {"ok": True, "photosKept": photo_count, "videosKept": video_count}


async def reorder_albums(db: AsyncSession, uid, ids) -> list[dict]:
    order = [str(x) for x in (ids if isinstance(ids, list) else [])]
    if not order:
        raise bad("Nothing to reorder")
    for i, aid in enumerate(order):
        a = await db.get(GalleryAlbum, aid)
        if a:
            a.sort_order = i + 1
    await db.flush()
    _audit(db, uid, "gallery.album_reorder", "gallery_album", None, {"order": order})
    await db.commit()
    return await list_albums(db)


# --- photos -------------------------------------------------------------------
async def add_photo(db: AsyncSession, uid, data: bytes, claimed: str, original_name: str,
                    *, album_id=None, caption="", alt_text="", license="", credit="",
                    credit_url="", order=None, active=True) -> dict:
    name, _real = _store(data, claimed, "galp-")
    vt = _variants(name)
    photo_id = "gp" + rid(5)
    now = _now_ms()
    if order is None:
        order = int((await db.execute(select(func.coalesce(func.max(GalleryPhoto.sort_order), 0)))).scalar_one()) + 1
    else:
        order = v_int(order, "Order", min_val=0, max_val=9999)
    ph = GalleryPhoto(id=photo_id, album_id=await _album_id(db, album_id), filename=name,
                      thumb=vt["thumb"] or None, webp=vt["webp"] or None,
                      thumb_webp=vt["thumb_webp"] or None,
                      caption=v_str(caption, "Caption", max_len=200, optional=True),
                      alt_text=v_str(alt_text, "Alt text", max_len=300, optional=True),
                      license=v_str(license, "License", max_len=120, optional=True),
                      credit=v_str(credit, "Credit", max_len=200, optional=True),
                      credit_url=v_str(credit_url, "Credit URL", max_len=300, optional=True),
                      sort_order=order, active=1 if _flag(active) else 0,
                      created=now, updated=now)
    db.add(ph)
    await db.flush()
    _audit(db, uid, "gallery.photo_add", "gallery_photo", photo_id,
           {"albumId": ph.album_id, "file": name})
    await db.commit()
    await db.refresh(ph)
    return s_photo(ph)


async def update_photo(db: AsyncSession, uid, photo_id: str, b: dict) -> dict:
    ph = await db.get(GalleryPhoto, photo_id)
    if not ph:
        raise not_found("Photo not found")
    b = b or {}
    old = {"albumId": ph.album_id, "active": bool(ph.active)}
    if "caption" in b:
        ph.caption = v_str(b["caption"], "Caption", max_len=200, optional=True)
    if "altText" in b:
        ph.alt_text = v_str(b["altText"], "Alt text", max_len=300, optional=True)
    if "license" in b:
        ph.license = v_str(b["license"], "License", max_len=120, optional=True)
    if "credit" in b:
        ph.credit = v_str(b["credit"], "Credit", max_len=200, optional=True)
    if "creditUrl" in b:
        ph.credit_url = v_str(b["creditUrl"], "Credit URL", max_len=300, optional=True)
    if "albumId" in b:
        ph.album_id = await _album_id(db, b["albumId"])
    if "order" in b:
        ph.sort_order = v_int(b["order"], "Order", min_val=0, max_val=9999)
    if "active" in b:
        ph.active = 1 if _flag(b["active"]) else 0
    ph.updated = _now_ms()
    await db.flush()
    _audit(db, uid, "gallery.photo_update", "gallery_photo", photo_id,
           {"from": old, "to": {"albumId": ph.album_id, "active": bool(ph.active)}},
           old_value={"active": old["active"]}, new_value={"active": bool(ph.active)})
    await db.commit()
    await db.refresh(ph)
    return s_photo(ph)


async def delete_photo(db: AsyncSession, uid, photo_id: str, reason: str | None = None) -> dict:
    ph = await db.get(GalleryPhoto, photo_id)
    if not ph:
        raise not_found("Photo not found")
    files = [ph.filename, ph.thumb, ph.webp, ph.thumb_webp]
    caption, album_id = ph.caption, ph.album_id
    await db.delete(ph)
    _audit(db, uid, "gallery.photo_delete", "gallery_photo", photo_id,
           {"caption": caption or "", "albumId": album_id}, reason=reason)
    await db.commit()
    _unlink_artifacts(files)
    return {"ok": True}


async def reorder_photos(db: AsyncSession, uid, ids) -> dict:
    order = [str(x) for x in (ids if isinstance(ids, list) else [])]
    if not order:
        raise bad("Nothing to reorder")
    for i, pid in enumerate(order):
        ph = await db.get(GalleryPhoto, pid)
        if ph:
            ph.sort_order = i + 1
    await db.flush()
    _audit(db, uid, "gallery.photo_reorder", "gallery_photo", None, {"order": order})
    await db.commit()
    return {"ok": True}


# --- videos -------------------------------------------------------------------
def _clean_video_url(x) -> str:
    u = str(x or "").strip()[:300]
    if not u:
        raise bad("Add a video link")
    if not u.lower().startswith(("http://", "https://")):
        raise bad("Video link must start with http:// or https://")
    return u


async def list_all_videos(db: AsyncSession) -> list[dict]:
    rows = (await db.execute(select(GalleryVideo)
                             .order_by(GalleryVideo.sort_order, GalleryVideo.created))).scalars().all()
    return [s_video(r) for r in rows]


async def create_video(db: AsyncSession, uid, b: dict) -> dict:
    b = b or {}
    title = v_str(b.get("title"), "Title", max_len=120)
    vid = "gv" + rid(5)
    if b.get("order") is None:
        order = int((await db.execute(select(func.coalesce(func.max(GalleryVideo.sort_order), 0)))).scalar_one()) + 1
    else:
        order = v_int(b.get("order"), "Order", min_val=0, max_val=999)
    now = _now_ms()
    v = GalleryVideo(id=vid, album_id=await _album_id(db, b.get("albumId")), title=title,
                     description=v_str(b.get("description"), "Description", max_len=500, optional=True),
                     url=_clean_video_url(b.get("url")), sort_order=order,
                     active=1 if b.get("active") is None or _flag(b.get("active")) else 0,
                     created=now, updated=now)
    db.add(v)
    await db.flush()
    _audit(db, uid, "gallery.video_create", "gallery_video", vid, {"title": title, "albumId": v.album_id})
    await db.commit()
    await db.refresh(v)
    return s_video(v)


async def update_video(db: AsyncSession, uid, vid: str, b: dict) -> dict:
    v = await db.get(GalleryVideo, vid)
    if not v:
        raise not_found("Video not found")
    b = b or {}
    old = {"url": v.url, "active": bool(v.active)}
    if "title" in b:
        v.title = v_str(b["title"], "Title", max_len=120)
    if "description" in b:
        v.description = v_str(b["description"], "Description", max_len=500, optional=True)
    if "url" in b:
        v.url = _clean_video_url(b["url"])
    if "albumId" in b:
        v.album_id = await _album_id(db, b["albumId"])
    if "order" in b:
        v.sort_order = v_int(b["order"], "Order", min_val=0, max_val=999)
    if "active" in b:
        v.active = 1 if _flag(b["active"]) else 0
    v.updated = _now_ms()
    await db.flush()
    _audit(db, uid, "gallery.video_update", "gallery_video", vid,
           {"from": old, "to": {"url": v.url, "active": bool(v.active)}},
           old_value={"active": old["active"]}, new_value={"active": bool(v.active)})
    await db.commit()
    await db.refresh(v)
    return s_video(v)


async def delete_video(db: AsyncSession, uid, vid: str, reason: str | None = None) -> dict:
    v = await db.get(GalleryVideo, vid)
    if not v:
        raise not_found("Video not found")
    title, album_id = v.title, v.album_id
    await db.delete(v)
    _audit(db, uid, "gallery.video_delete", "gallery_video", vid,
           {"title": title, "albumId": album_id}, reason=reason)
    await db.commit()
    return {"ok": True}


async def reorder_videos(db: AsyncSession, uid, ids) -> dict:
    order = [str(x) for x in (ids if isinstance(ids, list) else [])]
    if not order:
        raise bad("Nothing to reorder")
    for i, vid in enumerate(order):
        v = await db.get(GalleryVideo, vid)
        if v:
            v.sort_order = i + 1
    await db.flush()
    _audit(db, uid, "gallery.video_reorder", "gallery_video", None, {"order": order})
    await db.commit()
    return {"ok": True}


# --- reads --------------------------------------------------------------------
def _clamp_limit(x) -> int:
    try:
        n = int(x) if x is not None else 12
    except (TypeError, ValueError):
        n = 12
    return max(1, min(PAGE_MAX, n))


def _clamp_offset(x) -> int:
    try:
        n = int(x) if x is not None else 0
    except (TypeError, ValueError):
        n = 0
    return max(0, n)


async def public_photos(db: AsyncSession, *, album=None, limit=12, offset=0) -> dict:
    lim, off = _clamp_limit(limit), _clamp_offset(offset)
    # LEFT JOIN on purpose: an un-albumed row (never grouped, or left behind by
    # a deleted album) still belongs to the public Photos tab — only a HIDDEN
    # album hides its members.
    q = (select(GalleryPhoto).outerjoin(GalleryAlbum, GalleryAlbum.id == GalleryPhoto.album_id)
         .where(GalleryPhoto.active == 1,
                or_(GalleryAlbum.id.is_(None), GalleryAlbum.active == 1)))
    if album:
        q = q.where(GalleryPhoto.album_id == str(album))
    total = int((await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one())
    rows = (await db.execute(q.order_by(GalleryPhoto.sort_order, GalleryPhoto.created)
                             .limit(lim).offset(off))).scalars().all()
    return {"photos": [s_photo(r) for r in rows], "total": total,
            "nextOffset": (off + len(rows)) if off + len(rows) < total else None}


async def public_videos(db: AsyncSession, *, album=None, limit=12, offset=0) -> dict:
    lim, off = _clamp_limit(limit), _clamp_offset(offset)
    q = (select(GalleryVideo).outerjoin(GalleryAlbum, GalleryAlbum.id == GalleryVideo.album_id)
         .where(GalleryVideo.active == 1,
                or_(GalleryAlbum.id.is_(None), GalleryAlbum.active == 1)))
    if album:
        q = q.where(GalleryVideo.album_id == str(album))
    total = int((await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one())
    rows = (await db.execute(q.order_by(GalleryVideo.sort_order, GalleryVideo.created)
                             .limit(lim).offset(off))).scalars().all()
    return {"videos": [s_video(r) for r in rows], "total": total,
            "nextOffset": (off + len(rows)) if off + len(rows) < total else None}


async def public_gallery(db: AsyncSession, *, kind="photos", album=None, limit=12, offset=0) -> dict:
    """kind=photos|videos|albums picks the tab; the album filter narrows it.
    Every response carries the active album cards so the filter chips never
    need a second request."""
    kind = kind if kind in ("photos", "videos", "albums") else "photos"
    album = str(album) if album else ""
    if album:
        a = await get_album(db, album)
        if not a or not a.active:
            raise bad("Album not found")
    out = {"kind": kind, "albums": await list_active_albums(db)}
    if kind == "albums":
        return out
    if kind == "videos":
        page = await public_videos(db, album=album, limit=limit, offset=offset)
    else:
        page = await public_photos(db, album=album, limit=limit, offset=offset)
    return {**out, **page}


async def overview(db: AsyncSession) -> dict:
    """Compact overview that rides along in /state so the public page renders
    instantly; \"load more\" pages through public_gallery."""
    first = await public_photos(db, limit=24)
    vids = await public_videos(db, limit=50)
    return {"albums": await list_active_albums(db), "photos": first["photos"],
            "videos": vids["videos"],
            "totalPhotos": first["total"], "totalVideos": vids["total"]}


async def admin_bundle(db: AsyncSession) -> dict:
    photos = (await db.execute(select(GalleryPhoto)
                               .order_by(GalleryPhoto.sort_order, GalleryPhoto.created))).scalars().all()
    return {"albums": await list_albums(db),
            "photos": [s_photo(p) for p in photos],
            "videos": await list_all_videos(db)}
