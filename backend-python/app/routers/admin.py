"""Admin routes — port of the booking/commerce half of server/routes/admin.js:
assign, status changes, refunds, coupons, commission settings, samagri kits and
prasad management (delete protection included). Media, accounts and kundali
admin routes live in their own modules / arrive with their milestones."""
import json
import re
import time

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..models import (AuditLog, Booking, Coupon, KycDocument, Kit, Order, Pandit,
                      Prasad, Puja, Setting, User)
from ..security import require_role
from ..serialize import booking as s_booking, coupon as s_coupon, payout as s_payout
from ..services import bookings as B
from ..services import kyc as KYC
from ..services import account_status as AS
from ..services.payout_engine import payout_rules, set_adjustment, transition
from ..util import bad, conflict, j, not_found, rid, v_arr, v_int, v_one_of, v_str

router = APIRouter(prefix="/api/admin", tags=["admin"])
admin_dep = require_role("admin")


@router.post("/bookings/manual", status_code=201)
async def manual_booking(body: dict, auth: dict = Depends(admin_dep),
                         db: AsyncSession = Depends(get_db)):
    return {"booking": s_booking(await B.admin_manual(db, body or {}))}


@router.post("/bookings/{booking_id}/assign")
async def assign(booking_id: str, body: dict, auth: dict = Depends(admin_dep),
                 db: AsyncSession = Depends(get_db)):
    return {"booking": s_booking(await B.admin_assign(db, booking_id,
                                                      (body or {}).get("panditId") or None))}


@router.post("/bookings/{booking_id}/status")
async def set_status(booking_id: str, body: dict, auth: dict = Depends(admin_dep),
                     db: AsyncSession = Depends(get_db)):
    return {"booking": s_booking(await B.admin_status(db, booking_id,
                                                      (body or {}).get("status")))}


# --- Phase 16: no-show handling + the settings-backed cancellation policy ---
from ..services import cancellation as CX  # noqa: E402


@router.post("/bookings/{booking_id}/noshow")
async def noshow(booking_id: str, body: dict, auth: dict = Depends(admin_dep),
                 db: AsyncSession = Depends(get_db)):
    row = await CX.admin_no_show(db, booking_id, auth["uid"], (body or {}).get("reason"))
    await db.commit()
    return {"booking": s_booking(row)}


@router.get("/cancellation-policy")
async def policy_view(auth: dict = Depends(admin_dep), db: AsyncSession = Depends(get_db)):
    return {"policy": await CX.get_policy(db)}


@router.put("/cancellation-policy")
async def policy_update(body: dict, auth: dict = Depends(admin_dep),
                        db: AsyncSession = Depends(get_db)):
    pol = await CX.update_policy(db, auth["uid"], body or {})
    await db.commit()
    return {"policy": pol}


@router.post("/bookings/{booking_id}/refund")
async def process_refund(booking_id: str, auth: dict = Depends(admin_dep),
                         db: AsyncSession = Depends(get_db)):
    row = await B.get_booking(db, booking_id)
    if not row or not row.refund:
        raise not_found("No refund on this booking")
    rf = j(row.refund, {})
    rf["state"] = "Processed"
    row.refund = json.dumps(rf)
    row.log = json.dumps(j(row.log, []) + [["Refund processed", time.strftime("%Y-%m-%d")]],
                         ensure_ascii=False)
    await db.flush()
    return {"booking": s_booking(await B.get_booking(db, booking_id))}


@router.post("/coupons", status_code=201)
async def create_coupon(body: dict, auth: dict = Depends(admin_dep),
                        db: AsyncSession = Depends(get_db)):
    b = body or {}
    code = re.sub(r"[^A-Z0-9]", "", v_str(b.get("code"), "Code", max_len=20).upper())
    if not code:
        raise bad("Code is required")
    if (await db.execute(select(Coupon).where(Coupon.code == code).limit(1))).scalar_one_or_none():
        raise conflict("That code already exists")
    ctype = v_one_of(b.get("type"), ["pct", "flat"], "Type")
    val = v_int(b.get("val"), "Value", min_val=1, max_val=90 if ctype == "pct" else 100000)
    db.add(Coupon(code=code, type=ctype, val=val,
                  max=v_int(b.get("max"), "Max", min_val=1, max_val=100000) if b.get("max") is not None else None,
                  min=v_int(b.get("min"), "Min", min_val=0, max_val=1000000) if b.get("min") is not None else 0,
                  active=1, used=0))
    await db.flush()
    return {"ok": True, "code": code}


@router.post("/settings")
async def set_settings(body: dict, auth: dict = Depends(admin_dep),
                       db: AsyncSession = Depends(get_db)):
    val = v_int((body or {}).get("commission"), "Commission", min_val=0, max_val=60)
    row = (await db.execute(select(Setting).where(Setting.key == "commission"))).scalar_one_or_none()
    prev = json.loads(row.value) if row and row.value else None
    if row:
        row.value = json.dumps(val)
    else:
        db.add(Setting(key="commission", value=json.dumps(val)))
    db.add(AuditLog(actor_user_id=auth["uid"], actor_role="admin", action="settings.commission",
                    entity="settings", entity_id="commission",
                    detail=json.dumps({"from": prev, "to": val}),
                    old_value=json.dumps(prev) if prev is not None else None,
                    new_value=json.dumps(val), created_at=int(time.time() * 1000)))
    await db.flush()
    return {"ok": True}


# --- payout engine (Phases 7-8) --------------------------------------------------
HOLD_CHECKS = {"pandit_kyc", "bank", "dispute", "review", "refund", "reconciliation", "admin"}


@router.get("/payout-rules")
async def get_payout_rules(auth: dict = Depends(admin_dep), db: AsyncSession = Depends(get_db)):
    return {"holds": await payout_rules(db)}


@router.post("/payout-rules")
async def put_payout_rules(body: dict, auth: dict = Depends(admin_dep),
                           db: AsyncSession = Depends(get_db)):
    holds = []
    for h in v_arr((body or {}).get("holds"), "Holds"):
        if not isinstance(h, dict):
            raise bad("Each hold needs reason and check")
        holds.append({"reason": v_str(h.get("reason"), "Reason", max_len=120),
                      "check": v_one_of(h.get("check"), HOLD_CHECKS, "Check")})
    row = (await db.execute(select(Setting).where(Setting.key == "payout_holds"))).scalar_one_or_none()
    prev = json.loads(row.value) if row and row.value else None
    if row:
        row.value = json.dumps(holds)
    else:
        db.add(Setting(key="payout_holds", value=json.dumps(holds)))
    db.add(AuditLog(actor_user_id=auth["uid"], actor_role="admin", action="settings.payout_holds",
                    entity="settings", entity_id="payout_holds",
                    detail=json.dumps({"from": prev, "to": holds}),
                    old_value=json.dumps(prev) if prev is not None else None,
                    new_value=json.dumps(holds), created_at=int(time.time() * 1000)))
    await db.flush()
    return {"ok": True, "holds": holds}


@router.get("/payouts/{payout_id}")
async def get_payout_detail(payout_id: str, auth: dict = Depends(admin_dep),
                            db: AsyncSession = Depends(get_db)):
    from ..services.payout_engine import get_payout

    row = await get_payout(db, payout_id)
    if not row:
        raise not_found("Payout not found")
    return {"payout": s_payout(row)}


@router.post("/payouts/{payout_id}/process")
async def payout_process(payout_id: str, auth: dict = Depends(admin_dep),
                         db: AsyncSession = Depends(get_db)):
    return {"payout": s_payout(await transition(db, payout_id, "process", auth["uid"]))}


@router.post("/payouts/{payout_id}/hold")
async def payout_hold(payout_id: str, body: dict, auth: dict = Depends(admin_dep),
                      db: AsyncSession = Depends(get_db)):
    b = body or {}
    return {"payout": s_payout(await transition(db, payout_id, "hold", auth["uid"],
                                                reason=b.get("reason"), note=b.get("note")))}


@router.post("/payouts/{payout_id}/disburse")
async def payout_disburse(payout_id: str, body: dict, auth: dict = Depends(admin_dep),
                          db: AsyncSession = Depends(get_db)):
    b = body or {}
    return {"payout": s_payout(await transition(db, payout_id, "disburse", auth["uid"],
                                                payment_ref=b.get("paymentRef"), utr=b.get("utr")))}


@router.post("/payouts/{payout_id}/fail")
async def payout_fail(payout_id: str, body: dict, auth: dict = Depends(admin_dep),
                      db: AsyncSession = Depends(get_db)):
    return {"payout": s_payout(await transition(db, payout_id, "fail", auth["uid"],
                                                reason=(body or {}).get("reason")))}


@router.post("/payouts/{payout_id}/reverse")
async def payout_reverse(payout_id: str, body: dict, auth: dict = Depends(admin_dep),
                         db: AsyncSession = Depends(get_db)):
    return {"payout": s_payout(await transition(db, payout_id, "reverse", auth["uid"],
                                                reason=(body or {}).get("reason")))}


@router.post("/payouts/{payout_id}/adjustment")
async def payout_adjustment(payout_id: str, body: dict, auth: dict = Depends(admin_dep),
                            db: AsyncSession = Depends(get_db)):
    b = body or {}
    amt = v_int(b.get("amount"), "Adjustment", min_val=-10_000_000, max_val=10_000_000)
    return {"payout": s_payout(await set_adjustment(db, payout_id, amt, auth["uid"],
                                                    reason=b.get("reason")))}


# --- audit log viewer (Phase 31) -------------------------------------------------
# --- KYC documents (Phase 4) ---------------------------------------------------
@router.get("/kyc")
async def kyc_summary(auth: dict = Depends(admin_dep), db: AsyncSession = Depends(get_db)):
    return await KYC.summary(db)


@router.post("/kyc/{doc_id}/decide")
async def kyc_decide(doc_id: str, body: dict, auth: dict = Depends(admin_dep),
                     db: AsyncSession = Depends(get_db)):
    b = body or {}
    row = await KYC.decide(db, id=doc_id, uid=auth["uid"],
                           status=v_one_of(b.get("status"), KYC.STATUSES, "Status"),
                           reason=b.get("reason"), expires_at=b.get("expiresAt"),
                           reverify_at=b.get("reverifyAt"))
    return {"document": KYC.out(row)}


# --- Transactions ledger + commission tiers (Phases 9-10) ---
from ..services import ledger as LEDGER  # noqa: E402


@router.get("/ledger")
async def ledger_view(request: Request, auth: dict = Depends(admin_dep),
                      db: AsyncSession = Depends(get_db)):
    f = {k: v for k, v in request.query_params.items() if v}
    return {"entries": await LEDGER.list_entries(db, type=f.get("type"),
                                                 pandit_id=f.get("pandit"),
                                                 from_ts=f.get("from"), to_ts=f.get("to"),
                                                 limit=int(f.get("limit") or 200)),
            "totals": await LEDGER.totals(db, from_ts=f.get("from"), to_ts=f.get("to"))}


@router.get("/commission-tiers")
async def tier_list_view(auth: dict = Depends(admin_dep), db: AsyncSession = Depends(get_db)):
    return {"tiers": await LEDGER.tier_list(db)}


@router.post("/commission-tiers", status_code=201)
async def tier_create_view(body: dict, auth: dict = Depends(admin_dep),
                           db: AsyncSession = Depends(get_db)):
    r = await LEDGER.tier_create(db, auth["uid"], body or {})
    await db.commit()
    return {"tier": r}


@router.patch("/commission-tiers/{tier_id}")
async def tier_update_view(tier_id: int, body: dict, auth: dict = Depends(admin_dep),
                           db: AsyncSession = Depends(get_db)):
    r = await LEDGER.tier_update(db, auth["uid"], tier_id, body or {})
    await db.commit()
    return {"tier": r}


# --- QA & rating engine (Phase 17) + profile enrichment read (Phase 5) ---
from ..services import qa as QA_SVC  # noqa: E402


@router.get("/qa")
async def qa_list(auth: dict = Depends(admin_dep), db: AsyncSession = Depends(get_db)):
    return {"records": await QA_SVC.list_all(db)}


@router.post("/qa", status_code=201)
async def qa_create(body: dict, auth: dict = Depends(admin_dep),
                    db: AsyncSession = Depends(get_db)):
    b = body or {}
    rec = await QA_SVC.create(db, evaluator=auth["uid"], pandit_id=b.get("panditId"),
                              booking_id=b.get("bookingId"),
                              dims={"punctuality": b.get("punctuality"), "communication": b.get("communication"),
                                    "ritual_compliance": b.get("ritualCompliance"), "presentation": b.get("presentation"),
                                    "customer_interaction": b.get("customerInteraction"),
                                    "digital_capability": b.get("digitalCapability"),
                                    "documentation": b.get("documentation")},
                              notes=b.get("notes"))
    await db.commit()
    return rec


@router.delete("/qa/{qa_id}")
async def qa_delete(qa_id: str, auth: dict = Depends(admin_dep),
                    db: AsyncSession = Depends(get_db)):
    r = await QA_SVC.remove(db, id=qa_id, uid=auth["uid"])
    await db.commit()
    return r


@router.get("/pandits/{pandit_id}/qa")
async def pandit_qa(pandit_id: str, auth: dict = Depends(admin_dep),
                    db: AsyncSession = Depends(get_db)):
    from ..models import Pandit
    p = await db.get(Pandit, pandit_id)
    if not p:
        raise not_found("Pandit not found")
    return {"records": [QA_SVC.out(r) for r in await QA_SVC.for_pandit(db, pandit_id)],
            "derived": await QA_SVC.derived(db, pandit_id), "qaScore": p.qa_score}


@router.get("/kyc/{doc_id}/file")
async def kyc_file(doc_id: str, auth: dict = Depends(admin_dep),
                   db: AsyncSession = Depends(get_db)):
    """Streams the stored document; authenticated FileResponse (admin-only)."""
    from fastapi.responses import FileResponse
    import pathlib

    from ..config import get_settings

    row = (await db.execute(select(KycDocument).where(KycDocument.id == doc_id))).scalar_one_or_none()
    if not row:
        raise not_found("KYC document not found")
    file = pathlib.Path(get_settings().upload_dir) / "kyc" / pathlib.Path(row.file_name).name
    if not file.exists():
        raise not_found("File missing")
    return FileResponse(file)


# --- Trial poojas (Phase 18): schedule, assess + the activation gate ---
from ..services import trial as TRIAL  # noqa: E402


@router.get("/trials")
async def trials_view(panditId: str | None = None, auth: dict = Depends(admin_dep),
                      db: AsyncSession = Depends(get_db)):
    if panditId:
        return {"trials": await TRIAL.for_pandit(db, panditId)}
    return {"trials": await TRIAL.list_trials(db), "passMark": await TRIAL.pass_mark(db)}


@router.post("/trials", status_code=201)
async def trial_schedule(body: dict, auth: dict = Depends(admin_dep),
                         db: AsyncSession = Depends(get_db)):
    r = await TRIAL.schedule(db, auth["uid"], body or {})
    await db.commit()
    return {"trial": r}


@router.post("/trials/{trial_id}/record")
async def trial_record(trial_id: str, body: dict, auth: dict = Depends(admin_dep),
                       db: AsyncSession = Depends(get_db)):
    r = await TRIAL.record(db, auth["uid"], trial_id, body or {})
    await db.commit()
    return {"trial": r}


# --- Incident reporting (Phase 20): admin triage ---
from ..services import incidents as INC  # noqa: E402


@router.get("/incidents")
async def incidents_view(status: str | None = None, auth: dict = Depends(admin_dep),
                         db: AsyncSession = Depends(get_db)):
    return {"incidents": await INC.list_incidents(db, status), "counts": await INC.counts(db),
            "categories": INC.CATEGORIES}


@router.patch("/incidents/{incident_id}")
async def incident_triage(incident_id: str, body: dict, auth: dict = Depends(admin_dep),
                          db: AsyncSession = Depends(get_db)):
    r = await INC.triage(db, auth["uid"], incident_id, body or {})
    await db.commit()
    return {"incident": r}


@router.post("/pandits/{pandit_id}/kyc")
async def pandit_kyc(pandit_id: str, body: dict, auth: dict = Depends(admin_dep),
                     db: AsyncSession = Depends(get_db)):
    """Node parity: flip a pandit to verified/rejected. Phase 18 gate: activation
    (pending -> verified) requires a PASSED trial — KYC alone no longer verifies."""
    b = body or {}
    st = v_one_of(b.get("status"), ["verified", "rejected"], "Status")
    p = await db.get(Pandit, pandit_id)
    if not p:
        raise not_found("Pandit not found")
    gated = st == "verified" and p.status != "verified"
    if gated:
        await TRIAL.assert_activation_allowed(db, pandit_id)
    old = p.status
    p.status = st
    await db.flush()
    db.add(AuditLog(actor_user_id=auth["uid"], actor_role="admin", action="pandit.kyc",
                    entity="pandit", entity_id=pandit_id,
                    detail=json.dumps({"from": old, "to": st, "reason": b.get("reason"),
                                       "trialGate": "passed" if gated else "n/a"}),
                    created_at=int(time.time() * 1000)))
    await db.commit()
    return {"ok": True}


# --- Pandit account lifecycle (Phase 22) ---------------------------------------
@router.get("/pandit-lifecycle")
async def pandit_lifecycle(auth: dict = Depends(admin_dep), db: AsyncSession = Depends(get_db)):
    return {"pandits": await AS.overview(db)}


@router.post("/pandits/{pandit_id}/lifecycle")
async def pandit_lifecycle_set(pandit_id: str, body: dict, auth: dict = Depends(admin_dep),
                               db: AsyncSession = Depends(get_db)):
    b = body or {}
    p = await AS.transition(db, pandit_id, v_one_of(b.get("lifecycle"), AS.LIFECYCLE, "Lifecycle"),
                            auth["uid"], reason=b.get("reason"), note=b.get("note"),
                            frm=b.get("from"), to=b.get("to"), review_date=b.get("reviewDate"))
    from ..serialize import pandit as s_pandit

    return {"lifecycle": AS.current_lifecycle(p), "pandit": s_pandit(p, admin=True)}


@router.get("/audit")
async def audit_log(limit: int = 150, auth: dict = Depends(admin_dep),
                    db: AsyncSession = Depends(get_db)):
    limit = max(1, min(500, limit))
    rows = (await db.execute(select(AuditLog).order_by(AuditLog.id.desc()).limit(limit))).scalars().all()
    return {"entries": [{"id": a.id, "actor": a.actor_user_id, "role": a.actor_role,
                         "action": a.action, "entity": a.entity, "entityId": a.entity_id,
                         "detail": j(a.detail, {}),
                         "oldValue": j(a.old_value, a.old_value) if a.old_value else None,
                         "newValue": j(a.new_value, a.new_value) if a.new_value else None,
                         "reason": a.reason or None, "ip": a.ip or None,
                         "device": a.device or None, "ts": a.created_at} for a in rows]}


# --- Agreements (Phases 23-25): versioned publishing + acceptance registry ------
from fastapi import UploadFile, File, Form
import hashlib as _hs
import pathlib as _pl

from ..models import Agreement as _Agreement, AgreementAcceptance as _AA
from ..services import agreements as AG


@router.get("/agreements")
async def agreements_list(auth: dict = Depends(admin_dep), db: AsyncSession = Depends(get_db)):
    return {"agreements": await AG.list_all(db), "current": await AG.current_out(db)}


@router.post("/agreements", status_code=201)
async def agreements_create(body: dict, auth: dict = Depends(admin_dep),
                            db: AsyncSession = Depends(get_db)):
    b = body or {}
    row = await AG.create_draft(db, uid=auth["uid"], title=b.get("title"),
                                body=b.get("body"), effective_from=b.get("effectiveFrom"))
    return {"agreement": AG.out(row)}


@router.post("/agreements/{agreement_id}/publish")
async def agreements_publish(agreement_id: str, body: dict, auth: dict = Depends(admin_dep),
                             db: AsyncSession = Depends(get_db)):
    row = await AG.publish(db, agreement_id, auth["uid"], reason=(body or {}).get("reason"))
    return {"agreement": AG.out(row)}


@router.post("/agreements/{agreement_id}/archive")
async def agreements_archive(agreement_id: str, body: dict, auth: dict = Depends(admin_dep),
                             db: AsyncSession = Depends(get_db)):
    row = await AG.archive(db, agreement_id, auth["uid"], reason=(body or {}).get("reason"))
    return {"agreement": AG.out(row)}


@router.post("/agreements/file", status_code=201)
async def agreements_upload_file(doc: UploadFile | None = File(None), title: str = Form(...),
                                 effectiveFrom: str | None = Form(None),
                                 auth: dict = Depends(admin_dep),
                                 db: AsyncSession = Depends(get_db)):
    """Manual upload path (Phase 25): a scanned signed agreement (PDF) becomes a
    published version of its own; the file is stored under uploads/agreements."""
    from ..config import get_settings

    if doc is None:
        raise bad("Attach the signed agreement file")
    data = await doc.read(get_settings().max_upload_mb * 1024 * 1024 + 1)
    if len(data) > get_settings().max_upload_mb * 1024 * 1024:
        raise bad("File too large")
    claimed = doc.content_type or ""
    if claimed == "application/pdf":
        if data[:5] != b"%PDF-":
            raise bad("File content does not match its type")
    else:
        from ..util import verify_upload
        verify_upload(data, claimed)
    ext = ".pdf" if claimed == "application/pdf" else "." + claimed.split("/")[-1]
    file_name = rid(16) + ext
    dest = _pl.Path(get_settings().upload_dir) / "agreements"
    dest.mkdir(parents=True, exist_ok=True)
    (dest / file_name).write_bytes(data)
    row = await AG.manual_upload(db, uid=auth["uid"], title=title, file_name=file_name,
                                 data=data, effective_from=effectiveFrom)
    return {"agreement": AG.out(row)}


@router.get("/agreements/{agreement_id}/acceptances")
async def agreements_acceptances(agreement_id: str, auth: dict = Depends(admin_dep),
                                 db: AsyncSession = Depends(get_db)):
    if not await db.get(_Agreement, agreement_id):
        raise not_found("Agreement not found")
    return {"acceptances": await AG.acceptance_list(db, agreement_id)}


@router.get("/agreements/{agreement_id}/file")
async def agreements_file(agreement_id: str, auth: dict = Depends(admin_dep),
                          db: AsyncSession = Depends(get_db)):
    from fastapi.responses import FileResponse
    from ..config import get_settings

    row = await db.get(_Agreement, agreement_id)
    if not row:
        raise not_found("Agreement not found")
    if not row.file_name:
        raise not_found("This version was published as text, not a file")
    f = _pl.Path(get_settings().upload_dir) / "agreements" / _pl.Path(row.file_name).name
    if not f.exists():
        raise not_found("File missing")
    return FileResponse(f)


# --- samagri kits / prasad ------------------------------------------------------
@router.post("/kits", status_code=201)
async def create_kit(body: dict, auth: dict = Depends(admin_dep),
                     db: AsyncSession = Depends(get_db)):
    b = body or {}
    name = v_str(b.get("name"), "Kit name", max_len=80)
    id = ("k_" + re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:30] + "_" + rid(2))
    items = [v_str(x, "Kit contents", max_len=80) for x in v_arr(b.get("items"), "Kit contents", 40)]
    db.add(Kit(id=id, name=name, price=v_int(b.get("price"), "Price", min_val=0, max_val=1000000),
               icon="🧘", items=json.dumps([i for i in items if i]),
               stock=v_int(20 if b.get("stock") in (None, "") else b.get("stock"),
                           "Stock", min_val=0, max_val=100000), active=1))
    await db.flush()
    return {"id": id}


@router.patch("/kits/{kit_id}")
async def patch_kit(kit_id: str, body: dict, auth: dict = Depends(admin_dep),
                    db: AsyncSession = Depends(get_db)):
    k = await db.get(Kit, kit_id)
    if not k:
        raise not_found("Kit not found")
    b = body or {}
    if "name" in b:
        k.name = v_str(b["name"], "Kit name", max_len=80)
    if "price" in b:
        k.price = v_int(b["price"], "Price", min_val=0, max_val=1000000)
    if "stock" in b:
        k.stock = v_int(b["stock"], "Stock", min_val=0, max_val=100000)
    if "active" in b:
        k.active = 1 if b["active"] else 0
    await db.flush()
    return {"ok": True}


@router.post("/prasad", status_code=201)
async def create_prasad(body: dict, auth: dict = Depends(admin_dep),
                        db: AsyncSession = Depends(get_db)):
    b = body or {}
    name = v_str(b.get("name"), "Prasad name", max_len=80)
    id = "pr" + rid(3)
    db.add(Prasad(id=id, name=name, price=v_int(b.get("price"), "Price", min_val=0, max_val=1000000),
                  icon="🍬", descr=v_str(b.get("descr") or "", "Description", optional=True, max_len=200),
                  stock=None if b.get("stock") in (None, "") else v_int(b["stock"], "Stock", min_val=0, max_val=100000),
                  active=1))
    await db.flush()
    return {"id": id}


@router.patch("/prasad/{prasad_id}")
async def patch_prasad(prasad_id: str, body: dict, auth: dict = Depends(admin_dep),
                       db: AsyncSession = Depends(get_db)):
    pr = await db.get(Prasad, prasad_id)
    if not pr:
        raise not_found("Prasad item not found")
    b = body or {}
    if "name" in b:
        pr.name = v_str(b["name"], "Prasad name", max_len=80)
    if "price" in b:
        pr.price = v_int(b["price"], "Price", min_val=0, max_val=1000000)
    if "stock" in b:
        pr.stock = None if b["stock"] is None else v_int(b["stock"], "Stock", min_val=0, max_val=100000)
    if "active" in b:
        pr.active = 1 if b["active"] else 0
    await db.flush()
    return {"ok": True}


def _like(id: str) -> str:
    return "%" + json.dumps(id)[1:-1] + "%"


async def _item_used(db: AsyncSession, id: str) -> int:
    bk = (await db.execute(select(func.count()).select_from(Booking).where(
        (Booking.sam.like(_like(id))) | (Booking.pra.like(_like(id)))))).scalar_one()
    od = (await db.execute(select(func.count()).select_from(Order).where(
        Order.items.like(_like(id))))).scalar_one()
    return bk + od


@router.delete("/kits/{kit_id}")
async def delete_kit(kit_id: str, auth: dict = Depends(admin_dep),
                     db: AsyncSession = Depends(get_db)):
    k = await db.get(Kit, kit_id)
    if not k:
        raise not_found("Kit not found")
    if (await db.execute(select(Puja).where(Puja.kit == k.id).limit(1))).scalar_one_or_none():
        raise conflict("This kit is assigned to a puja. Deactivate it instead.")
    if await _item_used(db, k.id):
        raise conflict("Past bookings or orders still reference this kit. Deactivate it instead.")
    await db.delete(k)
    await db.flush()
    return {"ok": True}


@router.delete("/prasad/{prasad_id}")
async def delete_prasad(prasad_id: str, auth: dict = Depends(admin_dep),
                        db: AsyncSession = Depends(get_db)):
    pr = await db.get(Prasad, prasad_id)
    if not pr:
        raise not_found("Prasad item not found")
    if await _item_used(db, pr.id):
        raise conflict("Past bookings or orders still reference this item. Deactivate it instead.")
    await db.delete(pr)
    await db.flush()
    return {"ok": True}
