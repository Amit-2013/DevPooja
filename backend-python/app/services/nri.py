"""NRI packages (master plan Phase 13) — Python twin of server/services/nri.js.

Fixed-price puja packages sold to the diaspora in their own currency (USD
default; `inr_equiv` feeds the INR ledger and the rupee display). Commercial
pattern mirrors kundali billing: quote from the catalogue row, idempotent
checkout through the existing idempotency_keys store, exactly one ledger row
per order (NRI_PAYMENT via ledger.dedupe, amount = inr_equiv so reports stay
in one currency). Statuses: PENDING_PAYMENT -> PAID (mock mode marks PAID
immediately, exactly like kundali mock payments). Everything audited on
admin writes."""
import json
import time

from sqlalchemy import select

from ..models import AuditLog, IdempotencyKey, NriOrder, NriPackage
from ..util import bad, not_found, rid

CURRENCIES = ["USD", "GBP", "AED", "INR"]


def _now_ms() -> int:
    return int(time.time() * 1000)


def out(r: NriPackage) -> dict:
    try:
        includes = json.loads(r.includes or "[]")
    except (TypeError, ValueError):
        includes = []
    return {"id": r.id, "name": r.name, "descr": r.descr or "", "price": r.price,
            "currency": r.currency, "inrEquiv": r.inr_equiv, "includes": includes,
            "active": bool(r.active), "created": r.created}


def out_order(r: NriOrder) -> dict:
    return {"id": r.id, "packageId": r.package_id, "userId": r.user_id, "amount": r.amount,
            "currency": r.currency, "inrEquiv": r.inr_equiv, "status": r.status, "created": r.created}


async def get(db, pid: str) -> NriPackage | None:
    return await db.get(NriPackage, pid)


async def list_all(db) -> list[dict]:
    rows = (await db.execute(select(NriPackage).order_by(NriPackage.price))).scalars().all()
    return [out(r) for r in rows]


async def list_active(db) -> list[dict]:
    rows = (await db.execute(select(NriPackage).where(NriPackage.active == 1)
                             .order_by(NriPackage.price))).scalars().all()
    return [out(r) for r in rows]


async def orders_for(db, user_id: str) -> list[dict]:
    rows = (await db.execute(select(NriOrder).where(NriOrder.user_id == user_id)
                             .order_by(NriOrder.created.desc()))).scalars().all()
    return [out_order(r) for r in rows]


async def all_orders(db) -> list[dict]:
    rows = (await db.execute(select(NriOrder).order_by(NriOrder.created.desc()).limit(500))).scalars().all()
    return [out_order(r) for r in rows]


def _clean_includes(raw) -> list[str]:
    return [str(x)[:120] for x in (raw if isinstance(raw, list) else [])][:12]


def _validate_price(raw) -> int:
    try:
        price = round(float(raw))
    except (TypeError, ValueError):
        raise bad("Package price must be positive")
    if price <= 0:
        raise bad("Package price must be positive")
    return price


async def create_package(db, uid, b: dict) -> dict:
    b = b or {}
    if b.get("currency") not in CURRENCIES:
        raise bad("Unsupported currency")
    price = _validate_price(b.get("price"))
    pid = "nrp" + rid(4)
    db.add(NriPackage(id=pid, name=str(b.get("name") or "").strip()[:120],
                      descr=str(b.get("descr") or "")[:500], price=price,
                      currency=b["currency"], inr_equiv=round(float(b.get("inrEquiv") or 0)),
                      includes=json.dumps(_clean_includes(b.get("includes"))),
                      active=1, created=_now_ms()))
    await db.flush()
    db.add(AuditLog(actor_user_id=uid, actor_role="admin", action="nri.package_create",
                    entity="nri_package", entity_id=pid,
                    detail=json.dumps({"name": b.get("name"), "price": price, "currency": b["currency"]}),
                    created_at=_now_ms()))
    await db.commit()
    return out(await db.get(NriPackage, pid))


async def update_package(db, uid, pid: str, b: dict) -> dict:
    p = await db.get(NriPackage, pid)
    if not p:
        raise not_found("Package not found")
    b = b or {}
    old_active = bool(p.active)
    if "name" in b:
        p.name = str(b["name"]).strip()[:120]
    if "descr" in b:
        p.descr = str(b["descr"])[:500]
    if "price" in b:
        p.price = _validate_price(b["price"])
    if "currency" in b:
        if b["currency"] not in CURRENCIES:
            raise bad("Unsupported currency")
        p.currency = b["currency"]
    if "inrEquiv" in b:
        p.inr_equiv = round(float(b["inrEquiv"] or 0))
    if "includes" in b:
        p.includes = json.dumps(_clean_includes(b["includes"]))
    if "active" in b:
        p.active = 1 if b["active"] else 0
    await db.flush()
    db.add(AuditLog(actor_user_id=uid, actor_role="admin", action="nri.package_update",
                    entity="nri_package", entity_id=pid,
                    detail=json.dumps({"from": {"price": p.price, "active": old_active},
                                       "to": {"price": p.price, "active": bool(p.active)}}),
                    old_value=json.dumps({"active": old_active}),
                    new_value=json.dumps({"active": bool(p.active)}),
                    created_at=_now_ms()))
    await db.commit()
    await db.refresh(p)
    return out(p)


async def delete_package(db, uid, pid: str) -> dict:
    p = await db.get(NriPackage, pid)
    if not p:
        raise not_found("Package not found")
    used = (await db.execute(select(NriOrder.id).where(NriOrder.package_id == pid).limit(1))).scalar_one_or_none()
    if used:
        raise bad("Past orders reference this package. Deactivate it instead.")
    await db.delete(p)
    db.add(AuditLog(actor_user_id=uid, actor_role="admin", action="nri.package_delete",
                    entity="nri_package", entity_id=pid,
                    detail=json.dumps({"name": p.name}), created_at=_now_ms()))
    await db.commit()
    return {"ok": True}


async def checkout(db, uid, user_id: str, b: dict) -> dict:
    b = b or {}
    p = await db.get(NriPackage, str(b.get("packageId") or ""))
    if not p or not p.active:
        raise not_found("Package not available")
    key = str(b.get("idem") or "").strip()
    if not key:
        raise bad("Idempotency key required")
    key = key[:120]
    scope = "nri_order"
    hit = (await db.execute(select(IdempotencyKey.result).where(
        IdempotencyKey.key == key, IdempotencyKey.scope == scope))).scalar_one_or_none()
    if hit:
        return json.loads(hit)
    from .bookings import next_seq  # Node parity: shared sequence helper
    oid = "NR" + str(await next_seq(db, "nri_seq", 5001))
    now = _now_ms()
    order = NriOrder(id=oid, package_id=p.id, user_id=user_id, amount=p.price,
                     currency=p.currency, inr_equiv=p.inr_equiv, status="PAID",
                     idem=key, created=now)
    db.add(order)
    db.add(IdempotencyKey(key=key, scope=scope, result=json.dumps(out_order(order)),
                          created_at=now))
    await db.flush()
    from ..models import Transaction
    from ..services.ledger import dedupe
    await dedupe(db, type="NRI_PAYMENT", amount=p.inr_equiv, user_id=user_id,
                 ref_table="nri_orders", ref_id=oid,
                 note="NRI package " + p.name + " (" + p.currency + " " + str(p.price) + ")")
    await db.commit()
    return out_order(order)
