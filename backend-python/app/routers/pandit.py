"""Pandit routes — port of server/routes/pandit.js booking actions, availability,
profile and featured listing (media endpoints already live in routers/media.py;
pandit registration arrives with KYC uploads)."""
import json

from fastapi import APIRouter, Depends, Request, UploadFile, File, Form
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..models import Pandit, Puja
from ..security import require_role
from ..serialize import booking as s_booking
from ..services import bookings as B
from ..services import kyc as KYC
from ..services.availability import check as av_check, config_of, resolve_place
from ..services.otp import issue as otp_issue
from ..util import bad, j, rid, v_date, v_int, v_one_of, v_str
from ..pricing import SLOTS

router = APIRouter(prefix="/api/pandit", tags=["pandit"])
pandit_dep = require_role("pandit")

CITIES = ["Delhi NCR", "Mumbai", "Bengaluru", "Pune", "Jaipur", "Lucknow",
          "Varanasi", "Ahmedabad", "Chennai", "Hyderabad"]


def _list(x) -> list[str]:
    if isinstance(x, list):
        return [str(s).strip() for s in x if str(s).strip()]
    return [s.strip() for s in str(x or "").split(",") if s.strip()]


async def _verified(db: AsyncSession, pid: str) -> None:
    p = await db.get(Pandit, pid)
    if not p or p.status != "verified":
        raise bad("Your KYC is not verified yet")


@router.post("/bookings/{booking_id}/complete")
async def pandit_complete(booking_id: str,
                          media: list[UploadFile] | None = File(None),
                          auth: dict = Depends(pandit_dep),
                          db: AsyncSession = Depends(get_db)):
    """Declared BEFORE the generic /{action} route so FastAPI matches it first
    (Node used a regex route that excluded 'complete'; here order does it)."""
    await _verified(db, auth["pid"])
    from ..config import get_settings
    from ..util import rid, verify_upload
    from pathlib import Path
    urls = []
    for f in (media or [])[:8]:
        data = await f.read()
        real = verify_upload(data, f.content_type or "")
        name = rid(8) + {"image/jpeg": ".jpg", "image/png": ".png",
                         "image/webp": ".webp"}[real]
        d = Path(get_settings().upload_dir) / "media"
        d.mkdir(parents=True, exist_ok=True)
        (d / name).write_bytes(data)
        urls.append("/media/" + name)
    row = await B.pandit_act(db, auth["pid"], booking_id, "complete", urls)
    return {"booking": s_booking(row)}


@router.post("/bookings/{booking_id}/cancel")
async def cancel_booking(booking_id: str, body: dict, auth: dict = Depends(pandit_dep),
                         db: AsyncSession = Depends(get_db)):
    """Phase 16: pandit-side cancellation — customer refunded at the standard
    tier; compensation only outside the notice window (services/cancellation)."""
    from ..services.cancellation import pandit_cancel
    row = await pandit_cancel(db, auth["pid"], booking_id, (body or {}).get("reason"))
    await db.commit()
    return {"booking": s_booking(row)}


@router.post("/bookings/{booking_id}/{action}")
async def pandit_booking_action(booking_id: str, action: str,
                                auth: dict = Depends(pandit_dep),
                                db: AsyncSession = Depends(get_db)):
    if action not in ("accept", "reject", "start"):
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Not found")
    await _verified(db, auth["pid"])
    row = await B.pandit_act(db, auth["pid"], booking_id, action)
    return {"booking": s_booking(row)}


@router.post("/availability")
async def toggle_availability(body: dict, auth: dict = Depends(pandit_dep),
                              db: AsyncSession = Depends(get_db)):
    date = v_date((body or {}).get("date"))
    p = await db.get(Pandit, auth["pid"])
    off = j(p.off, [])
    # A structured blocked entry takes priority: the legacy toggle un-blocks it.
    blocked = j(p.blocked_dates, [])
    bi = next((i for i, b in enumerate(blocked) if isinstance(b, dict) and b.get("date") == date), None)
    if bi is not None:
        blocked.pop(bi)
        p.blocked_dates = json.dumps(blocked)
    if date in off:
        off.remove(date)
    else:
        off.append(date)
    p.off = json.dumps(off)
    await db.flush()
    return {"ok": True}


# --- Centralized availability calendar (Phase 3) ---------------------------------
@router.get("/calendar")
async def get_calendar(auth: dict = Depends(pandit_dep), db: AsyncSession = Depends(get_db)):
    p = await db.get(Pandit, auth["pid"])
    return {"calendar": config_of(p)}


@router.put("/calendar")
async def put_calendar(body: dict, auth: dict = Depends(pandit_dep),
                       db: AsyncSession = Depends(get_db)):
    b = body or {}
    p = await db.get(Pandit, auth["pid"])
    weekly = sorted({v_int(n, "Weekday", min_val=0, max_val=6)
                     for n in (b.get("weeklyOff") or []) if isinstance(n, int)})
    slots = [s for s in (b.get("slots") or []) if s in SLOTS]
    radius = b.get("radiusKm")
    radius = None if radius in (None, "") else v_int(radius, "Radius", min_val=1, max_val=500)
    base = None
    if b.get("baseLat") is not None and b.get("baseLon") is not None:
        base = (float(b["baseLat"]), float(b["baseLon"]))
    elif b.get("baseCity"):
        pl = await resolve_place(db, b["baseCity"])
        base = (pl.lat, pl.lon) if pl else None
    if radius is not None and base is None and p.base_lat is None and not await resolve_place(db, p.city):
        raise bad("Set a base location (or a recognizable city) before enabling the service radius")
    p.weekly_off = json.dumps(weekly)
    p.slots = json.dumps(slots)
    p.radius_km = radius
    if base is not None:
        p.base_lat, p.base_lon = base
    if b.get("onlineEnabled") is not None:
        p.online_enabled = 1 if b["onlineEnabled"] else 0
    if b.get("templeEnabled") is not None:
        p.temple_enabled = 1 if b["templeEnabled"] else 0
    await db.flush()
    await db.refresh(p)
    return {"calendar": config_of(p)}


@router.post("/calendar/dates")
async def calendar_dates(body: dict, auth: dict = Depends(pandit_dep),
                         db: AsyncSession = Depends(get_db)):
    b = body or {}
    date = v_date(b.get("date"))
    kind = v_one_of(b.get("kind") or "holiday", ["holiday", "blocked"], "Kind")
    p = await db.get(Pandit, auth["pid"])
    holidays = j(p.holidays, [])
    blocked = j(p.blocked_dates, [])
    if kind == "holiday":
        if date in holidays:
            holidays.remove(date)
        else:
            holidays.append(date)
    else:
        idx = next((i for i, x in enumerate(blocked)
                    if isinstance(x, dict) and x.get("date") == date), None)
        if idx is not None:
            blocked.pop(idx)
        else:
            blocked.append({"date": date, "reason": str(b.get("reason") or "")[:120]})
    p.holidays = json.dumps(holidays)
    p.blocked_dates = json.dumps(blocked)
    await db.flush()
    await db.refresh(p)
    return {"calendar": config_of(p)}


@router.get("/calendar/why")
async def calendar_why(date: str, slot: str | None = None, mode: str | None = None,
                       auth: dict = Depends(pandit_dep), db: AsyncSession = Depends(get_db)):
    date_v = v_date(date)
    slot_v = slot if slot in SLOTS else None
    p = await db.get(Pandit, auth["pid"])
    return {"verdict": await av_check(db, p, date_v, slot_v, mode=mode)}


# --- My KYC documents (Phase 4; closes the upload parity gap) ---------------------
@router.get("/kyc/documents")
async def kyc_documents(auth: dict = Depends(pandit_dep), db: AsyncSession = Depends(get_db)):
    rows = await KYC.for_pandit(db, auth["pid"])
    return {"documents": [KYC.out(r) for r in rows]}


@router.post("/kyc/documents", status_code=201)
async def kyc_upload(docType: str = Form(...), doc: UploadFile | None = File(None),
                     auth: dict = Depends(pandit_dep), db: AsyncSession = Depends(get_db)):
    from ..config import get_settings
    from ..util import verify_upload as vu

    if doc is None:
        raise bad("Attach the document file")
    data = await doc.read(get_settings().max_upload_mb * 1024 * 1024 + 1)
    if len(data) > get_settings().max_upload_mb * 1024 * 1024:
        raise bad("File too large")
    claimed = doc.content_type or ""
    if claimed == "application/pdf":
        if data[:5] != b"%PDF-":
            raise bad("File content does not match its type")
    else:
        vu(data, claimed)
    file_name = rid(16) + (".pdf" if claimed == "application/pdf" else "." + claimed.split("/")[-1])
    import pathlib

    kyc_dir = pathlib.Path(get_settings().upload_dir) / "kyc"
    kyc_dir.mkdir(parents=True, exist_ok=True)
    (kyc_dir / file_name).write_bytes(data)
    row = await KYC.upload(db, pid=auth["pid"], uid=auth["uid"], doc_type=docType,
                           file_name=file_name, original_name=doc.filename or "")
    return {"document": KYC.out(row)}


# --- My agreement (Phases 23-25) -------------------------------------------------
@router.get("/agreement")
async def my_agreement(auth: dict = Depends(pandit_dep), db: AsyncSession = Depends(get_db)):
    from ..services import agreements as AG
    return await AG.for_pandit(db, auth["pid"])


@router.post("/agreement/send-otp")
async def send_agreement_otp(auth: dict = Depends(pandit_dep), db: AsyncSession = Depends(get_db)):
    """The acceptance OTP is issued SERVER-SIDE against the pandit's registered
    mobile (pandits.mobile) — the portal never needs to know the number. Reuses
    services.otp.issue (same otps table as /auth/otp/send; demo code 123456)."""
    p = await db.get(Pandit, auth["pid"])
    if not p or not p.mobile:
        raise bad("Your account has no registered mobile number — add one before accepting")
    return await otp_issue(db, p.mobile)


@router.post("/agreement/accept")
async def accept_agreement(body: dict, request: Request, auth: dict = Depends(pandit_dep),
                           db: AsyncSession = Depends(get_db)):
    """Digital acceptance: consent checkbox + OTP verified against the pandit's
    registered mobile; the acceptance row records method/OTP flag/IP/device and
    an enriched audit entry. Version-locked — a repeat is 409."""
    from ..services import agreements as AG
    b = body or {}
    row = await AG.accept(db, pid=auth["pid"], uid=auth["uid"],
                          agreement_id=b.get("agreementId"), consent=b.get("consent"),
                          otp=b.get("otp"),
                          ip=request.client.host if request.client else "",
                          device=request.headers.get("user-agent", ""))
    return {"acceptance": AG.out_acceptance(row)}


@router.patch("/profile")
async def update_profile(body: dict, auth: dict = Depends(pandit_dep),
                         db: AsyncSession = Depends(get_db)):
    b = body or {}
    puja_ids = set((await db.execute(select(Puja.id))).scalars().all())
    spec = [s for s in _list(b.get("spec")) if s in puja_ids]
    if not spec:
        raise bad("Select at least one puja")
    p = await db.get(Pandit, auth["pid"])
    p.city = b.get("city") if b.get("city") in CITIES else "Delhi NCR"
    p.exp = v_int(b.get("exp"), "Experience", min_val=0, max_val=70)
    p.langs = json.dumps(_list(b.get("langs"))[:10])
    p.bio = v_str(b.get("bio"), "About", optional=True, max_len=600)
    p.spec = json.dumps(spec)
    p.avail = 1 if b.get("avail") else 0
    # Phase 5 enrichment (optional free text, length-capped like the Node twin).
    p.gotra = v_str(b.get("gotra"), "Gotra", optional=True, max_len=60)
    p.qualifications = v_str(b.get("quals"), "Qualifications", optional=True, max_len=600)
    p.veda_school = v_str(b.get("veda"), "Tradition", optional=True, max_len=60)
    await db.flush()
    return {"ok": True}


@router.post("/profile/photo")
async def upload_profile_photo(photo: UploadFile = File(...),
                               auth: dict = Depends(pandit_dep),
                               db: AsyncSession = Depends(get_db)):
    """Profile photo (Phase 5): magic-checked image stored under media/ so it is
    served publicly from /media like catalogue photos; KYC files stay private."""
    from pathlib import Path
    from ..config import get_settings
    from ..util import rid, verify_upload
    data = await photo.read()
    real = verify_upload(data, photo.content_type or "")
    if real == "application/pdf":
        raise bad("Profile photos must be images")
    name = "prof-" + rid(10) + {"image/jpeg": ".jpg", "image/png": ".png",
                                "image/webp": ".webp"}.get(real, ".jpg")
    d = Path(get_settings().upload_dir) / "media"
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_bytes(data)
    p = await db.get(Pandit, auth["pid"])
    old, p.photo_file = p.photo_file, name
    await db.flush()
    if old:
        try:
            (d / old).unlink()
        except OSError:
            pass
    return {"ok": True, "photo": "/media/" + name}


@router.get("/me/qa")
async def my_qa(auth: dict = Depends(pandit_dep), db: AsyncSession = Depends(get_db)):
    """My QA history + derived service metrics (Phases 5 + 17)."""
    from ..services import qa as QA
    from ..services.qa import out as qa_out
    records = [qa_out(r) for r in await QA.for_pandit(db, auth["pid"])]
    return {"records": records, "derived": await QA.derived(db, auth["pid"])}


@router.get("/me/ledger")
async def my_ledger(auth: dict = Depends(pandit_dep), db: AsyncSession = Depends(get_db)):
    """My money ledger (Phase 10): DAKSHINA share rows and the negative PAYOUT
    rows that settle them — the pandit-side view of the transactions ledger."""
    from ..services import ledger as LEDGER
    return {"entries": await LEDGER.list_entries(db, pandit_id=auth["pid"], limit=50)}


@router.post("/feature")
async def get_featured(auth: dict = Depends(pandit_dep),
                       db: AsyncSession = Depends(get_db)):
    import os
    if (os.environ.get("PAYMENT_MODE") or "mock") != "mock":
        from ..util import http_error
        raise http_error(501, "Featured-listing billing is not wired to the gateway yet. See README.")
    p = await db.get(Pandit, auth["pid"])
    p.featured = 1
    await db.flush()
    return {"ok": True}
