"""QA & rating engine (master plan Phase 17) + the derived profile metrics for
Phase 5's profile enrichment — async twin of server/services/qa.js, on top of
migration 016's qa_records table.

Design (Node parity):
- qa_records: one scored observation per booking, written by an admin.
  Dimension vocabulary mirrors 014's trial_poojas (same 7 axes, 1..5).
- overall is computed server-side as the mean of the supplied dimensions.
- pandits.qa_score is a cached average refreshed on every write; customer
  reviews keep driving pandits.rating unchanged.
- cancellation%/no-show% are DERIVED from bookings on read, never stored:
  cancelled-while-assigned = this pandit was assigned when the booking was
  cancelled; no-show proxy = past scheduled date, was assigned, never
  Started nor Completed. Denominator = assigned bookings incl. cancelled.
"""
import time

from sqlalchemy import select

from ..db import SessionLocal  # noqa: F401  (re-exported for tests)
from ..models import AuditLog, Booking, Notif, Pandit, QaRecord
from ..util import bad, conflict, not_found, rid

DIMENSIONS = ["punctuality", "communication", "ritual_compliance", "presentation",
              "customer_interaction", "digital_capability", "documentation"]


def out(r: QaRecord, pandit_name: str | None = None) -> dict:
    return {
        "id": r.id, "panditId": r.pandit_id, "panditName": pandit_name, "bookingId": r.booking_id,
        "evaluator": r.evaluator,
        "dims": {
            "punctuality": r.punctuality, "communication": r.communication,
            "ritualCompliance": r.ritual_compliance, "presentation": r.presentation,
            "customerInteraction": r.customer_interaction, "digitalCapability": r.digital_capability,
            "documentation": r.documentation,
        },
        "overall": r.overall, "notes": r.notes or "", "createdAt": r.created_at,
    }


async def _audit(db, actor: str, action: str, entity: str, entity_id: str,
                 detail: dict, *, old: dict | None = None, new: dict | None = None) -> None:
    db.add(AuditLog(actor_user_id=actor or None, actor_role="admin", action=action, entity=entity,
                    entity_id=entity_id, detail=__import__("json").dumps(detail or {}),
                    old_value=__import__("json").dumps(old) if old is not None else None,
                    new_value=__import__("json").dumps(new) if new is not None else None,
                    created_at=int(time.time() * 1000)))


async def derived(db, pandit_id: str) -> dict:
    """Phase 5 metrics derived from bookings (never stored)."""
    from sqlalchemy import func
    today = time.strftime("%Y-%m-%d")
    assigned = (await db.execute(select(func.count()).select_from(Booking).where(
        Booking.pandit_id == pandit_id, Booking.status != "PendingPayment"))).scalar_one()
    canc = (await db.execute(select(func.count()).select_from(Booking).where(
        Booking.pandit_id == pandit_id, Booking.status == "Cancelled"))).scalar_one()
    no_show = (await db.execute(select(func.count()).select_from(Booking).where(
        Booking.pandit_id == pandit_id, Booking.date < today,
        Booking.status.notin_(["Completed", "Cancelled", "PendingPayment"])))).scalar_one()
    pct = lambda n: round(100 * n / assigned) if assigned else 0  # noqa: E731
    return {"assigned": assigned, "cancelledWhileAssigned": canc, "noShows": no_show,
            "cancelPct": pct(canc), "noShowPct": pct(no_show)}


async def refresh_score(db, pandit_id: str) -> float | None:
    from sqlalchemy import func
    row = (await db.execute(select(func.avg(QaRecord.overall), func.count()).where(
        QaRecord.pandit_id == pandit_id, QaRecord.overall.is_not(None)))).one()
    score = round(row[0], 1) if row[1] else None
    p = await db.get(Pandit, pandit_id)
    if p:
        p.qa_score = score
    return score


async def for_pandit(db, pandit_id: str) -> list[QaRecord]:
    rows = (await db.execute(select(QaRecord).where(QaRecord.pandit_id == pandit_id)
                             .order_by(QaRecord.created_at.desc()).limit(200))).scalars().all()
    return list(rows)


async def list_all(db) -> list[dict]:
    rows = (await db.execute(select(QaRecord, Pandit.name).outerjoin(Pandit, Pandit.id == QaRecord.pandit_id)
                             .order_by(QaRecord.created_at.desc()).limit(300))).all()
    return [out(r, name) for r, name in rows]


async def create(db, *, evaluator: str, pandit_id: str, booking_id: str | None,
                 dims: dict, notes: str | None) -> dict:
    p = await db.get(Pandit, pandit_id)
    if not p:
        raise not_found("Pandit not found")
    booking = None
    if booking_id:
        booking = await db.get(Booking, booking_id)
        if not booking:
            raise not_found("Booking not found")
        if booking.pandit_id != pandit_id:
            raise bad("The booking belongs to a different pandit")
    given: dict[str, int] = {}
    for k in DIMENSIONS:
        val = (dims or {}).get(k)
        if val is None or val == "":
            continue
        try:
            f = float(val)
        except (TypeError, ValueError):
            raise bad(f"{k} must be an integer 1..5")
        # Node parity: a true integer is required (int(2.5) truncating silently
        # would corrupt the mean), not just an integral value.
        if not f.is_integer() or not (1 <= f <= 5):
            raise bad(f"{k} must be an integer 1..5")
        given[k] = int(f)
    if not given:
        raise bad("Score at least one dimension (1..5)")
    overall = round(sum(given.values()) / len(given.values()), 1)
    rec = QaRecord(id="qa" + rid(6), pandit_id=pandit_id, booking_id=booking_id if booking else None,
                   evaluator=evaluator,
                   punctuality=given.get("punctuality"), communication=given.get("communication"),
                   ritual_compliance=given.get("ritual_compliance"), presentation=given.get("presentation"),
                   customer_interaction=given.get("customer_interaction"),
                   digital_capability=given.get("digital_capability"),
                   documentation=given.get("documentation"),
                   overall=overall, notes=(notes or None) and str(notes)[:500],
                   created_at=int(time.time() * 1000))
    db.add(rec)
    await refresh_score(db, pandit_id)
    await _audit(db, evaluator, "qa.recorded", "pandit", pandit_id,
                 {"qaId": rec.id, "bookingId": booking_id, "dims": given, "overall": overall},
                 new={"overall": overall, **given})
    if p.user_id:
        db.add(Notif(user_id=p.user_id, channel="In-App",
                     message=f"A service-quality review was recorded: {overall}/5 overall.",
                     ts=int(time.time() * 1000)))
    return out(rec)


async def remove(db, *, id: str, uid: str) -> dict:
    rec = (await db.execute(select(QaRecord).where(QaRecord.id == id))).scalar_one_or_none()
    if not rec:
        raise not_found("QA record not found")
    await db.delete(rec)
    await refresh_score(db, rec.pandit_id)
    await _audit(db, uid, "qa.deleted", "pandit", rec.pandit_id,
                 {"qaId": id, "overall": rec.overall}, old={"overall": rec.overall})
    return {"ok": True}
