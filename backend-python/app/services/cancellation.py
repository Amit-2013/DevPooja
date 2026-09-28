"""Cancellation & rescheduling engine (master plan Phase 16) — async twin of
server/services/cancellation.js. ONE writer for booking cancellations:
`_cancel_internal` moves here (bookings.py keeps a re-export alias so every
existing call site — expire-unpaid, admin status, gateway rollback, customer
cancel — keeps working unchanged). Rules that were hardcoded become
settings-backed policy with the exact legacy defaults:

  policy = { full: 48, part: 24, fullPct: 100, partPct: 75, latePct: 50,
             noshowPct: 25, compPct: 50, noticeHours: 24 }

  full/part   refund tier windows in hours before the puja (full >= 48h,
              part >= 24h, otherwise late). Legacy: pricing.refund_pct() =
              >48h 100%, >24h 75%, else 50%.
  noshowPct   refund to the customer when a pandit misses the puja (default
              25% — the customer is refunded AND the pandit is paid nothing).
  compPct     pandit compensation % of their share for pandit-side cancels
              outside the notice window and for no-shows (default 50%).
  noticeHours minimum notice a pandit must give (default 24h) — cancelling
              inside it counts against the pandit and pays no compensation.

New surfaces (mirroring the Node engine):
  pandit_cancel        customer gets the standard tier refund; compensation
                       only outside the notice window; the booking keeps its
                       pandit_id so the QA cancelPct metric attributes it.
  pandit_no_show_sweep past-date still-active bookings with a pandit are
                       cancelled as no-shows (customer refund noshowPct, pandit
                       compensation, audits). Idempotent — cancelled rows no
                       longer match the finder.
  admin_no_show        admin forces a no-show now with an explicit reason.
  get/update policy    audited settings-backed policy CRUD.

Money invariants (identical to Node): refunds flow through the deduped REFUND
ledger entry inside _cancel_internal; compensation is a real PENDING payout row
plus its deduped DAKSHINA ledger entry carried by the normal payout lifecycle.
"""
import json
import time

from sqlalchemy import select, update

from ..models import AuditLog, Booking, Notif, Pandit, Payout, Setting
from ..pricing import SLOTS, hours_until
from ..util import bad, conflict, j, not_found, v_date, v_one_of

DEFAULTS = {"full": 48, "part": 24, "fullPct": 100, "partPct": 75, "latePct": 50,
            "noshowPct": 25, "compPct": 50, "noticeHours": 24}

OPEN = ["New", "Confirmed", "Assigned"]


def _today() -> str:
    return time.strftime("%Y-%m-%d")


def _now_ms() -> int:
    return int(time.time() * 1000)


async def get_setting(db, key: str, default):
    row = (await db.execute(select(Setting).where(Setting.key == key))).scalar_one_or_none()
    return j(row.value, default) if row else default


async def _set_setting(db, key: str, value) -> None:
    row = (await db.execute(select(Setting).where(Setting.key == key))).scalar_one_or_none()
    if row:
        row.value = json.dumps(value)
    else:
        db.add(Setting(key=key, value=json.dumps(value)))


async def policy(db) -> dict:
    raw = await get_setting(db, "cancellation_policy", {}) or {}
    merged = dict(DEFAULTS)
    merged.update({k: raw[k] for k in raw if k in DEFAULTS})
    return merged


def _log_append(row: Booking, text: str) -> str:
    log = j(row.log, [])
    log.append([text, _today()])
    return json.dumps(log)


async def refund_tier(db, date: str, slot: str, pol: dict | None = None) -> dict:
    """Same tier shape as Node: pct + which tier fired."""
    p = pol or await policy(db)
    h = hours_until(date, slot)
    if h > p["full"]:
        return {"pct": p["fullPct"], "tier": "full"}
    if h > p["part"]:
        return {"pct": p["partPct"], "tier": "part"}
    return {"pct": p["latePct"], "tier": "late"}


async def _audit(db, actor, action, entity, entity_id, detail, old_value=None, new_value=None) -> None:
    db.add(AuditLog(actor_user_id=actor or None, actor_role="admin" if actor else "system",
                    action=action, entity=entity, entity_id=entity_id,
                    detail=json.dumps(detail),
                    old_value=json.dumps(old_value) if old_value is not None else None,
                    new_value=json.dumps(new_value) if new_value is not None else None,
                    created_at=_now_ms()))


async def _cancel_internal(db, row: Booking, pct: int, reason: str,
                           send_notice: bool = True, by: str = "system") -> Booking:
    q = j(row.q, {})
    paid = j(row.pay, {}).get("paid")
    refund = ({"amt": round(q.get("total", 0) * pct / 100), "pct": pct, "state": "Initiated"}
              if paid and pct > 0 else None)
    row.status = "Cancelled"
    row.refund = json.dumps(refund) if refund else None
    row.log = _log_append(row, reason)
    # release resources: reward points + undelivered kit stock (from bookings.py)
    from ..models import Kit, User
    if q.get("pts"):
        await db.execute(update(User).where(User.id == row.user_id).values(pts=User.pts + q["pts"]))
    ops = j(row.ops, {})
    if ops.get("sam") != "Delivered":
        for k in j(row.sam, []):
            await db.execute(update(Kit).where(Kit.id == k).values(stock=Kit.stock + 1))
    if refund:
        from .ledger import dedupe
        await dedupe(db, type="REFUND", amount=-refund["amt"], user_id=row.user_id,
                     pandit_id=row.pandit_id, booking_id=row.id, ref_table="bookings",
                     ref_id=row.id + ":refund", note=f"Cancellation refund ({pct}%)")
    await db.flush()
    if send_notice:
        db.add(Notif(user_id=row.user_id, channel="Email",
                     message=f"Booking {row.id} cancelled." +
                             (f" Refund of Rs {refund['amt']} initiated." if refund else ""),
                     ts=_now_ms()))
    await _audit(db, None, "booking.cancelled", "booking", row.id,
                 {"by": by, "reason": reason, "refundPct": pct or 0,
                  "refundAmt": refund["amt"] if refund else 0},
                 new_value={"status": "Cancelled", "by": by, "reason": reason})
    return row


async def customer_cancel(db, user, id_: str) -> Booking:
    row = (await db.execute(select(Booking).where(Booking.id == id_))).scalar_one_or_none()
    if not row or row.user_id != user.id:
        raise not_found("Booking not found")
    if row.status not in OPEN + ["PendingPayment"]:
        raise bad("This booking can no longer be cancelled")
    t = await refund_tier(db, row.date, row.slot)
    return await _cancel_internal(db, row, t["pct"], "Cancelled by customer", True, "customer")


async def reschedule(db, user, id_: str, body: dict) -> Booking:
    """Customer reschedule — mirrors bookings.reschedule_booking (which now
    delegates here); validators from ..util, availability from the engine."""
    from .availability import check as av_check
    from .bookings import iso_offset
    row = (await db.execute(select(Booking).where(Booking.id == id_))).scalar_one_or_none()
    if not row or row.user_id != user.id:
        raise not_found("Booking not found")
    if row.status not in OPEN:
        raise bad("This booking can no longer be rescheduled")
    date = v_date(body.get("date"), "Date")
    if date < iso_offset(1):
        raise bad("Choose a date from tomorrow onwards")
    slot = v_one_of(body.get("slot"), SLOTS, "Time slot")
    if row.pandit_id:
        p = await db.get(Pandit, row.pandit_id)
        verdict = await av_check(db, p, date, slot, mode=row.mode,
                                 city=j(row.addr, {}).get("city"), skip_id=row.id)
        if not verdict["ok"]:
            raise conflict("Your pandit is not available then: " + verdict["reason"])
    try:
        row.date, row.slot = date, slot
        row.log = _log_append(row, "Rescheduled")
        await db.flush()
    except Exception as exc:  # integrity conflict parity with Node
        raise conflict("Your pandit is not free then.") from exc
    db.add(Notif(user_id=user.id, channel="SMS", message=f"Booking {id_} rescheduled to {date}, {slot}.", ts=_now_ms()))
    return row


async def compensate(db, pandit_id: str, row: Booking, net: int, pol: dict) -> str | None:
    """Real PENDING payout row + its DAKSHINA ledger entry. Idempotent per booking."""
    amt = round(net * pol["compPct"] / 100)
    if amt <= 0:
        return None
    from .bookings import next_seq
    pid = "POC" + str(await next_seq(db, "payout_comp_seq", 1)) + "-" + row.id
    db.add(Payout(id=pid, pandit_id=pandit_id, amount=amt, date=_today(), status="PENDING",
                  booking_id=row.id, gross_amount=amt, commission_amt=0, tax_amt=0,
                  refund_amt=0, adjustment_amt=0, currency="INR"))
    from .ledger import dedupe
    await dedupe(db, type="DAKSHINA", amount=amt, pandit_id=pandit_id, booking_id=row.id,
                 ref_table="payouts", ref_id=pid,
                 note=f"Cancellation compensation ({pol['compPct']}%)")
    return pid


async def pandit_net(db, row: Booking, pol: dict) -> int:
    po = (await db.execute(select(Payout).where(Payout.booking_id == row.id)
                           .order_by(Payout.id.desc()))).scalars().first()
    if po:
        return max(0, po.amount or 0)
    q = j(row.q, {})
    commission = await get_setting(db, "commission", 20)
    svc = q.get("svc", 0) or 0
    return max(0, svc - round(svc * (commission or 0) / 100))


async def pandit_cancel(db, pandit_id: str, id_: str, reason: str | None) -> Booking:
    row = (await db.execute(select(Booking).where(Booking.id == id_))).scalar_one_or_none()
    if not row or row.pandit_id != pandit_id:
        raise not_found("Booking not found")
    if row.status not in OPEN:
        raise bad("This booking can no longer be cancelled")
    pol = await policy(db)
    hours = hours_until(row.date, row.slot)
    within_notice = hours < pol["noticeHours"]
    t = await refund_tier(db, row.date, row.slot, pol)
    comp_id = None if within_notice else await compensate(db, pandit_id, row, await pandit_net(db, row, pol), pol)
    await _cancel_internal(db, row, t["pct"],
                           "Cancelled by pandit" + (f": {str(reason)[:160]}" if reason else ""),
                           True, "pandit")
    await _audit(db, pandit_id, "booking.cancelled_by_pandit", "booking", id_,
                 {"withinNotice": within_notice, "hours": round(hours),
                  "compensation": comp_id or "none", "customerRefundPct": t["pct"]},
                 new_value={"status": "Cancelled", "by": "pandit", "withinNotice": within_notice})
    if within_notice:
        db.add(Notif(user_id=pandit_id, channel="WhatsApp",
                     message=f"Booking {id_} was cancelled inside the {pol['noticeHours']}h notice window — no compensation for this booking.",
                     ts=_now_ms()))
    else:
        db.add(Notif(user_id=pandit_id, channel="WhatsApp",
                     message=f"You cancelled booking {id_} with enough notice. Compensation of the pandit share was credited to your payouts.",
                     ts=_now_ms()))
    return row


async def _no_show_cancel(db, row: Booking, actor) -> str | None:
    pol = await policy(db)
    await _cancel_internal(db, row, pol["noshowPct"], "Pandit did not arrive (no-show)", True, "noshow")
    comp_id = await compensate(db, row.pandit_id, row, await pandit_net(db, row, pol), pol) if row.pandit_id else None
    await _audit(db, actor, "booking.noshow", "booking", row.id,
                 {"panditId": row.pandit_id, "customerRefundPct": pol["noshowPct"],
                  "compensation": comp_id or "none"},
                 new_value={"status": "Cancelled", "by": "noshow"})
    if row.pandit_id:
        db.add(Notif(user_id=row.pandit_id, channel="Email",
                     message=f"Booking {row.id} was recorded as a no-show. Compensation was credited to your payouts; this affects your service metrics.",
                     ts=_now_ms()))
    return comp_id


async def pandit_no_show_sweep(db, actor=None) -> list[str]:
    rows = (await db.execute(select(Booking).where(
        Booking.pandit_id.is_not(None), Booking.date < _today(),
        Booking.status.in_(OPEN + ["Started"])))).scalars().all()
    handled = []
    for row in rows:
        await _no_show_cancel(db, row, actor)
        handled.append(row.id)
    return handled


async def admin_no_show(db, id_: str, actor, reason: str | None = None) -> Booking:
    row = (await db.execute(select(Booking).where(Booking.id == id_))).scalar_one_or_none()
    if not row:
        raise not_found("Booking not found")
    if row.status in ("Completed", "Cancelled"):
        raise bad("This booking is closed")
    if not row.pandit_id:
        raise bad("No pandit is assigned to this booking")
    await _no_show_cancel(db, row, actor)
    return row


async def admin_cancel(db, id_: str, actor, reason: str | None = None) -> Booking:
    row = (await db.execute(select(Booking).where(Booking.id == id_))).scalar_one_or_none()
    if not row:
        raise not_found("Booking not found")
    if row.status in ("Completed", "Cancelled"):
        raise bad("Closed bookings cannot be cancelled")
    return await _cancel_internal(db, row, 100, reason or "Cancelled by admin", True, "admin")


async def get_policy(db) -> dict:
    return await policy(db)


async def update_policy(db, actor, body: dict) -> dict:
    """Pct fields are 0..100; hour-window fields go up to a year (8760h) — they
    are windows, not percentages (parity: Node HOUR_KEYS/PCT_KEYS)."""
    cur = await policy(db)
    b = body or {}
    nxt = dict(cur)
    hour_keys = ("full", "part", "noticeHours")
    for k in DEFAULTS:
        if b.get(k) is None:
            continue
        try:
            n = float(b[k])
        except (TypeError, ValueError):
            raise bad(f"{k} must be between 0 and {8760 if k in hour_keys else 100}")
        mx = 8760 if k in hour_keys else 100
        if not 0 <= n <= mx:
            raise bad(f"{k} must be between 0 and {mx}")
        nxt[k] = n
    if not nxt["full"] > nxt["part"]:
        raise bad("The full-refund window must be longer than the part-refund window")
    await _set_setting(db, "cancellation_policy", nxt)
    await _audit(db, actor, "settings.cancellation_policy", "settings", "cancellation_policy",
                 {"from": {k: cur[k] for k in ("full", "part", "latePct", "noshowPct", "compPct")},
                  "to": {k: nxt[k] for k in ("full", "part", "latePct", "noshowPct", "compPct")}},
                 old_value={"full": cur["full"], "part": cur["part"]},
                 new_value={"full": nxt["full"], "part": nxt["part"]})
    return nxt
