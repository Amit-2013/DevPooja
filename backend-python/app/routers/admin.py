"""Admin routes — port of the booking/commerce half of server/routes/admin.js:
assign, status changes, refunds, coupons, commission settings, samagri kits and
prasad management (delete protection included). Media, accounts and kundali
admin routes live in their own modules / arrive with their milestones."""
import json
import re
import time

from fastapi import APIRouter, Depends
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..models import (AuditLog, Booking, Coupon, Kit, Order, Prasad, Puja, Setting)
from ..security import require_role
from ..serialize import booking as s_booking, coupon as s_coupon, payout as s_payout
from ..services import bookings as B
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
