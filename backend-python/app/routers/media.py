"""Media router — port of the pandit + admin media endpoints and the public
gallery route, with the same response shapes, status codes and security rules:
pandit uploads pending + alt-text-required, admin moderation, bulk ops,
4-artifact deletes, role-checked downloads, path-traversal-proof file serving."""
from pathlib import Path

from fastapi import APIRouter, Depends, UploadFile, File, Form
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..models import PujaMedia
from ..security import current_auth, require_role
from ..services import media
from ..util import bad, not_found, v_one_of

router = APIRouter(prefix="/api", tags=["media"])


def _read_upload_files(files: list[UploadFile] | None) -> list[tuple[bytes, str, str]]:
    """Read small uploads fully into memory (40 MB cap from settings)."""
    out = []
    for f in files or []:
        data = f.file.read(settings_max_mb() * 1024 * 1024 + 1)
        if len(data) > settings_max_mb() * 1024 * 1024:
            raise bad("File too large")
        out.append((data, f.content_type or "", f.filename or ""))
    return out


def settings_max_mb() -> int:
    from ..config import get_settings
    return get_settings().max_upload_mb


# --- public gallery -------------------------------------------------------------
@router.get("/pujas/{puja_id}/photos")
async def public_photos(puja_id: str, limit: int = 12, offset: int = 0,
                        category: str | None = None, db: AsyncSession = Depends(get_db)):
    return await media.public_for_puja(db, puja_id, limit=limit, offset=offset, category=category)


# --- pandit -----------------------------------------------------------------------
@router.post("/pandit/media", status_code=201)
async def pandit_media_upload(media_files: list[UploadFile] | None = File(None, alias="media"),
                              bookingId: str = Form(...),
                              altText: str = Form(...),
                              auth: dict = Depends(require_role("pandit")),
                              db: AsyncSession = Depends(get_db)):
    files = _read_upload_files(media_files)
    if not files:
        raise bad("Attach at least one photo")
    return {"media": await media.pandit_upload(
        db, pid=auth["pid"], uid=auth["uid"], booking_id=bookingId,
        files=files, alt_text=altText)}


@router.get("/pandit/media")
async def pandit_media_list(auth: dict = Depends(require_role("pandit")),
                            db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(PujaMedia).where(
        PujaMedia.pandit_id == auth["pid"]).order_by(PujaMedia.created_at.desc()).limit(200))).scalars().all()
    return {"media": [media.out(r) for r in rows]}


@router.delete("/pandit/media/{media_id}")
async def pandit_media_delete(media_id: str, auth: dict = Depends(require_role("pandit")),
                              db: AsyncSession = Depends(get_db)):
    return await media.remove(db, uid=auth["uid"], role="pandit", pid=auth["pid"], id=media_id)


# --- admin -----------------------------------------------------------------------
@router.get("/admin/media")
async def admin_media_list(status: str | None = None, source: str | None = None,
                           limit: int = 300,
                           auth: dict = Depends(require_role("admin")),
                           db: AsyncSession = Depends(get_db)):
    return {"media": await media.admin_list(db, status=status, source=source, limit=limit)}


@router.post("/admin/pujas/{puja_id}/media", status_code=201)
async def admin_media_upload(puja_id: str,
                             media_files: list[UploadFile] | None = File(None, alias="media"),
                             altText: str = Form(""),
                             category: str = Form("puja"),
                             published: str = Form("true"),
                             primary: str = Form("false"),
                             auth: dict = Depends(require_role("admin")),
                             db: AsyncSession = Depends(get_db)):
    files = _read_upload_files(media_files or [])
    if not files:
        raise bad("Attach at least one photo")
    from ..models import Puja
    if not await db.get(Puja, puja_id):
        raise not_found("Puja not found")
    return {"media": await media.admin_upload(
        db, uid=auth["uid"], puja_id=puja_id, files=files, alt_text=altText,
        category=category, published=published.lower() != "false",
        make_primary=primary.lower() == "true")}


@router.patch("/admin/media/{media_id}")
async def admin_media_moderate(media_id: str, body: dict,
                               auth: dict = Depends(require_role("admin")),
                               db: AsyncSession = Depends(get_db)):
    return {"media": await media.moderate(
        db, uid=auth["uid"], id=media_id, status=body.get("status"),
        published=body.get("published"), primary=bool(body.get("primary")),
        reject_reason=body.get("rejectReason", ""))}


@router.post("/admin/media/bulk")
async def admin_media_bulk(body: dict, auth: dict = Depends(require_role("admin")),
                           db: AsyncSession = Depends(get_db)):
    op = v_one_of(body.get("op"), ["approve", "reject", "publish", "unpublish", "delete"], "Operation")
    return await media.bulk(db, uid=auth["uid"], ids=body.get("ids", []), op=op)


@router.get("/admin/media/credits")
async def admin_media_credits(auth: dict = Depends(require_role("admin")),
                              db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(PujaMedia).order_by(PujaMedia.created_at))).scalars().all()
    return {"credits": [media.out(r) for r in rows]}


@router.delete("/admin/media/{media_id}")
async def admin_media_delete(media_id: str, auth: dict = Depends(require_role("admin")),
                             db: AsyncSession = Depends(get_db)):
    return await media.remove(db, uid=auth["uid"], role="admin", pid=None, id=media_id)


@router.get("/media/{media_id}/download")
async def media_download(media_id: str, auth: dict | None = Depends(current_auth),
                         db: AsyncSession = Depends(get_db)):
    f = await media.file_for(db, media_id, auth)
    return FileResponse(f["file"], media_type=f["mime"],
                        filename=Path(f["name"]).name, content_disposition_type="attachment")
