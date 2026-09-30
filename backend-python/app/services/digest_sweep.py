"""Daily reopen-digest sweep — Python twin of server/services/digestSweep.js.

Notifies admins of NEWLY flagged pandits, newly flagged customers and fresh
repeat-reopen queue entries without anyone opening Operations. Diffing
contract: a JSON snapshot of the previous sweep's state (flagged pandit ids,
flagged customer ids, live queue incident ids) lives in the settings table
under 'digest_sweep_state'; each pass notifies only what is new since last
time, so repeated runs never duplicate alerts. Tests drive tick() directly
instead of waiting on timers (scheduler.py contract)."""
import json
import time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Notif, User
from .reopen_digest import reopen_digest

KEY = "digest_sweep_state"


async def _get_setting(db: AsyncSession, key: str, default):
    from .bookings import get_setting
    return await get_setting(db, key, default)


async def _set_setting(db: AsyncSession, key: str, value) -> None:
    from sqlalchemy import text

    await db.execute(text(
        "INSERT INTO settings(key, value) VALUES(:k, :v) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value").bindparams(
        k=key, v=json.dumps(value)))


def _now_ms() -> int:
    return int(time.time() * 1000)


async def tick(db: AsyncSession) -> int:
    """One scheduled pass. Returns the number of admin notifications queued."""
    digest = await reopen_digest(db)
    flagged_pandits = [x["panditId"] for x in (digest.get("flaggedPandits") or [])]
    flagged_customers = [x["customerId"] for x in (digest.get("flaggedCustomers") or [])]
    queue = [x["id"] for x in (digest.get("incidents") or [])]
    prev = await _get_setting(db, KEY, {"flaggedPandits": [], "flaggedCustomers": [], "queue": []}) or {}

    def added(now, before):
        return [x for x in now if x not in (before or [])]

    new_pandits = added(flagged_pandits, prev.get("flaggedPandits"))
    new_customers = added(flagged_customers, prev.get("flaggedCustomers"))
    new_queue = added(queue, prev.get("queue"))

    snapshot = {"flaggedPandits": flagged_pandits, "flaggedCustomers": flagged_customers, "queue": queue}
    if not new_pandits and not new_customers and not new_queue:
        await _set_setting(db, KEY, snapshot)
        return 0

    admins = (await db.execute(select(User.id).where(User.role == "admin"))).scalars().all()
    if not admins:
        await _set_setting(db, KEY, snapshot)
        return 0

    by_p = {x["panditId"]: x for x in (digest.get("flaggedPandits") or [])}
    by_c = {x["customerId"]: x for x in (digest.get("flaggedCustomers") or [])}
    by_i = {x["id"]: x for x in (digest.get("incidents") or [])}

    lines = []
    for pid in new_pandits:
        x = by_p.get(pid) or {}
        lines.append(f"Flagged pandit: {x.get('pandit') or pid} is newly flagged for repeated incident "
                     f"reopens across {x.get('bookings', '?')} distinct bookings ({x.get('reopens', '?')} reopens).")
    for cid in new_customers:
        x = by_c.get(cid) or {}
        lines.append(f"Flagged customer: {x.get('customer') or cid} is newly flagged — reopened incidents "
                     f"across {x.get('bookings', '?')} distinct bookings ({x.get('reopens', '?')} reopens).")
    for iid in new_queue[:10]:
        x = by_i.get(iid) or {}
        cat = (x.get("category") or "incident").replace("_", " ").lower()
        lines.append(f"Review queue entry: incident {iid} ({cat}) is back with {x.get('reopenCount', '?')} reopens.")
    if len(new_queue) > 10:
        lines.append(f"…and {len(new_queue) - 10} more queue entries.")

    msg = f"Daily reopen digest — {len(lines)} update{'s' if len(lines) > 1 else ''}:\n" + "\n".join("• " + l for l in lines)
    for uid in admins:
        db.add(Notif(user_id=uid, channel="In-App", message=msg, ts=_now_ms()))
    await _set_setting(db, KEY, snapshot)
    return len(admins) * len(lines)
