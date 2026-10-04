"""Phase 19 — complaints workflow: ONE state machine for tickets, mirrored from
server/services/tickets.js.

Statuses: OPEN → UNDER_REVIEW → PANDIT_RESPONSE → CUSTOMER_RESPONSE →
DECISION → RESOLVED. The admin drives explicit transitions (DECISION and
RESOLVED require the written note, stored as tickets.resolution); a pandit
reply moves the ticket to PANDIT_RESPONSE and a customer reply to
CUSTOMER_RESPONSE on their own; RESOLVED only reopens through an explicit
admin transition (UNDER_REVIEW) — replies on a resolved ticket are refused
with guidance. Every reply lands in ticket_messages with optional evidence
attachments that must be /media/ urls from the magic-checked upload
endpoint; anything else is filtered out. Legacy rows carrying 'Open' or
'Resolved' normalise through norm() (migration 034 backfilled them in Node).
"""
import json
import time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import AuditLog, Booking, Ticket, TicketMessage, User
from ..util import bad, conflict, j, not_found, v_one_of, v_str

STATUSES = ["OPEN", "UNDER_REVIEW", "PANDIT_RESPONSE", "CUSTOMER_RESPONSE", "DECISION", "RESOLVED"]
ALLOWED = {
    "OPEN": ["UNDER_REVIEW", "PANDIT_RESPONSE", "CUSTOMER_RESPONSE", "RESOLVED"],
    "UNDER_REVIEW": ["PANDIT_RESPONSE", "CUSTOMER_RESPONSE", "DECISION", "RESOLVED"],
    "PANDIT_RESPONSE": ["CUSTOMER_RESPONSE", "DECISION", "UNDER_REVIEW", "RESOLVED"],
    "CUSTOMER_RESPONSE": ["PANDIT_RESPONSE", "UNDER_REVIEW", "DECISION", "RESOLVED"],
    "DECISION": ["RESOLVED", "UNDER_REVIEW", "CUSTOMER_RESPONSE"],
    "RESOLVED": ["UNDER_REVIEW"],  # admin reopens for further review
}
NOTE_REQUIRED = ["DECISION", "RESOLVED"]

# Legacy vocabulary lives in pre-034 rows and in old snapshots.
def norm(s):
    if s == "Open":
        return "OPEN"
    if s == "Resolved":
        return "RESOLVED"
    return s if s in STATUSES else "OPEN"


def out(t):
    """The state-payload ticket shape — serialize.py delegates here so the SPA,
    the detail endpoint and the pandit list all speak the same words."""
    if t is None:
        return None
    return {"id": t.id, "userId": t.user_id, "b": t.booking_id or "", "t": t.text,
            "st": norm(t.status), "prio": t.prio, "res": t.resolution or None,
            "up": t.updated_at or None}


def attach_list(a):
    """Evidence attachments: only urls the magic-checked upload endpoint returned."""
    if not isinstance(a, list):
        return []
    keep = [str(x) for x in a]
    return [x for x in keep if x.startswith("/media/") and len(x) <= 200][:8]


def _seq(oid):
    """Numeric part of a TM*/TK* id — stands in for SQLite rowid ordering on
    both SQLite and Postgres (same-ms messages keep insertion order)."""
    try:
        return int(str(oid)[2:])
    except (TypeError, ValueError):
        return 0


async def _audit(db, actor, action, entity_id, detail, old_value=None,
                 new_value=None, reason=None):
    """Node parity: actor_role derives from the users row; old/new values ride
    their own JSON-encoded columns so the audit view can query them."""
    role = None
    if actor:
        u = await db.get(User, actor)
        role = u.role if u else "system"
    db.add(AuditLog(actor_user_id=actor or None, actor_role=role, action=action,
                    entity="ticket", entity_id=entity_id,
                    detail=json.dumps(detail or {}),
                    old_value=json.dumps(old_value) if old_value is not None else None,
                    new_value=json.dumps(new_value) if new_value is not None else None,
                    reason=str(reason)[:300] if reason else None,
                    created_at=int(time.time() * 1000)))


async def _one(db, tid):
    t = await db.get(Ticket, tid)
    if not t:
        raise not_found("Ticket not found")
    return t


async def add_message(db, ticket_id, author_id, role, message, attachments):
    from .bookings import next_seq
    seq = await next_seq(db, "ticket_msg_seq", 5)
    mid = "TM" + str(seq)
    now = int(time.time() * 1000)
    db.add(TicketMessage(id=mid, ticket_id=ticket_id, author_id=author_id,
                         author_role=role, message=message,
                         attachments=json.dumps(attachments), created=now))
    t = await db.get(Ticket, ticket_id)
    if t:
        t.updated_at = now
    await db.flush()
    return {"id": mid, "authorId": author_id, "role": role, "message": message,
            "attachments": attachments, "created": now}


async def detail(db, tid):
    """Ticket + thread with author names (the detail both portals render).
    `next` is the legal transition set for the current status — the FE renders
    exactly those buttons instead of duplicating the state machine."""
    t = await _one(db, tid)
    rows = (await db.execute(
        select(TicketMessage, User.name).outerjoin(User, User.id == TicketMessage.author_id)
        .where(TicketMessage.ticket_id == tid))).all()
    msgs = [{"id": m.id, "authorId": m.author_id, "author": name or m.author_id,
             "role": m.author_role, "message": m.message,
             "attachments": j(m.attachments, []), "created": m.created}
            for m, name in rows]
    msgs.sort(key=lambda x: (x["created"] or 0, _seq(x["id"])))
    return {"ticket": {**out(t), "next": ALLOWED.get(norm(t.status), [])},
            "messages": msgs}


async def reply(db, tid, actor, role, body):
    """A reply. The role decides the status move; RESOLVED is closed for
    business (replies refused with the guidance a customer can act on)."""
    t = await _one(db, tid)
    st = norm(t.status)
    if st == "RESOLVED":
        raise conflict("This ticket is resolved. Raise a new ticket if the issue returns.")
    b = body or {}
    message = v_str(b.get("message") or "", "Message", max_len=1000)
    attachments = attach_list(b.get("attachments"))

    target = None
    if role == "customer":
        if st == "OPEN":
            target = None                     # still being triaged: just append
        elif st in ("UNDER_REVIEW", "PANDIT_RESPONSE", "DECISION"):
            target = "CUSTOMER_RESPONSE"
    elif role == "pandit":
        if st in ("OPEN", "UNDER_REVIEW", "CUSTOMER_RESPONSE"):
            target = "PANDIT_RESPONSE"
        elif st == "PANDIT_RESPONSE":
            target = None                     # follow-up on their own reply
        else:
            raise conflict("The admin is recording a decision on this complaint — wait for their move.")
    elif role == "admin":
        if st == "OPEN":
            target = "UNDER_REVIEW"           # an admin note starts the review
    if target and target not in ALLOWED.get(st, []):
        raise conflict(f"Cannot move a {st} ticket to {target}")

    msg = await add_message(db, tid, actor, role, message, attachments)
    if target:
        t.status = target
        t.updated_at = msg["created"]
        await db.flush()
    await _audit(db, actor, "ticket.replied", tid,
                 {"role": role, "status": target or st,
                  "attachments": len(attachments)})
    return {"ticket": out(await _one(db, tid)), "message": msg}


async def transition(db, tid, actor, body):
    """Explicit admin transition. DECISION/RESOLVED require the written note;
    the note also lands in the thread so both sides see the reasoning."""
    t = await _one(db, tid)
    st = norm(t.status)
    b = body or {}
    target = v_one_of(str(b.get("status") or "").upper(), STATUSES, "Status")
    if target == st:
        raise conflict(f"The ticket is already {st}")
    if target not in ALLOWED.get(st, []):
        raise conflict(f"Cannot move a {st} ticket to {target}")
    note = str(b.get("note") or "").strip()
    if target in NOTE_REQUIRED and not note:
        raise bad("A resolution is required to resolve a ticket"
                  if target == "RESOLVED" else "A decision note is required")
    if note:
        await add_message(db, tid, actor, "admin", note, [])
    now = int(time.time() * 1000)
    t.status = target
    if target in NOTE_REQUIRED:
        t.resolution = note
    t.updated_at = now
    await db.flush()
    await _audit(db, actor, "ticket.transitioned", tid,
                 {"from": st, "to": target},
                 old_value=st, new_value=target, reason=note or None)
    return out(await _one(db, tid))


async def for_pandit(db, ticket_out, pid):
    """Pandit scope: only tickets attached to one of their bookings."""
    if not ticket_out["b"]:
        return False
    b = await db.get(Booking, ticket_out["b"])
    return bool(b and b.pandit_id == pid)


async def list_for_pandit(db, pid):
    rows = (await db.execute(
        select(Ticket).join(Booking, Booking.id == Ticket.booking_id)
        .where(Booking.pandit_id == pid))).scalars().all()
    rows.sort(key=lambda t: (-(t.updated_at or 0), -_seq(t.id)))
    return [out(t) for t in rows]
