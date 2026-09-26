"""Centralized pandit availability engine (Phase 3) — twin of
server/services/availability.js. ONE module answers "can this pandit take this
booking?" for every path: customer booking, auto-assignment, admin assignment,
rescheduling. Check order and permissive defaults match the Node twin exactly
(empty lists / NULL radius = no restriction, so existing data keeps working)."""
import math

from sqlalchemy import select

from ..models import Booking, Pandit, PlaceIndex
from ..util import j

WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]


def _js_date_wd(iso_date: str) -> int:
    """JS getUTCDay() parity: 0=Sunday..6=Saturday, noon-anchored like the Node twin."""
    from datetime import datetime

    d = datetime.fromisoformat(iso_date + "T12:00:00+00:00")
    return (d.weekday() + 1) % 7  # Python Monday=0 -> JS Sunday=0 mapping


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    to_rad = math.pi / 180
    dlat = (lat2 - lat1) * to_rad
    dlon = (lon2 - lon1) * to_rad
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1 * to_rad) * math.cos(lat2 * to_rad) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


async def resolve_place(db, city: str | None):
    """Tolerant city match: 'Delhi NCR' matches place_index 'Delhi'."""
    if not city:
        return None
    rows = (await db.execute(
        select(PlaceIndex).where(PlaceIndex.country == "India")
        .order_by(PlaceIndex.population.desc()))).scalars().all()
    c = str(city)
    for row in rows:
        if row.city == c or c.startswith(row.city + " ") or row.city.startswith(c + " "):
            return row
    return None


async def check(db, p: Pandit | None, date: str, slot: str | None, *,
                mode: str | None = None, city: str | None = None,
                lat=None, lon=None, skip_id: str = "") -> dict:
    """The bookable formula. Returns {ok, reason, code} — first failure wins."""
    if not p:
        return {"ok": False, "reason": "Pandit not found", "code": "NOT_FOUND"}
    if p.status != "verified":
        return {"ok": False, "reason": "KYC verification pending", "code": "KYC"}
    if not p.avail:
        return {"ok": False, "reason": "Pandit is not accepting new bookings", "code": "AVAIL_FLAG"}

    weekly = j(p.weekly_off, [])
    wd = _js_date_wd(date)
    if wd in weekly:
        return {"ok": False, "reason": WD[wd] + " is a weekly off for this pandit", "code": "WEEKLY_OFF"}

    if date in j(p.holidays, []):
        return {"ok": False, "reason": "Pandit is on holiday on this date", "code": "HOLIDAY"}

    blocked = j(p.blocked_dates, [])
    hit = next((b for b in blocked if isinstance(b, dict) and b.get("date") == date), None)
    if hit:
        return {"ok": False, "reason": "Date blocked by the pandit" + (": " + hit["reason"] if hit.get("reason") else ""), "code": "BLOCKED"}

    if date in j(p.off, []):
        return {"ok": False, "reason": "Pandit marked this date unavailable", "code": "MARKED_OFF"}

    configured = j(p.slots, [])
    if slot and configured and slot not in configured:
        return {"ok": False, "reason": f"Pandit does not take bookings in the {slot} slot", "code": "SLOT"}

    if mode == "online" and not p.online_enabled:
        return {"ok": False, "reason": "Pandit does not offer online pujas", "code": "ONLINE_OFF"}
    if mode == "temple" and not p.temple_enabled:
        return {"ok": False, "reason": "Pandit does not offer temple services", "code": "TEMPLE_OFF"}

    if mode == "home" and p.radius_km is not None:
        base = None
        if p.base_lat is not None and p.base_lon is not None:
            base = (p.base_lat, p.base_lon)
        else:
            pl = await resolve_place(db, p.city)
            base = (pl.lat, pl.lon) if pl else None
        if not base:
            return {"ok": False, "reason": "Pandit base location is unknown; radius cannot be checked", "code": "RADIUS"}
        if lat is not None and lon is not None:
            dest = (float(lat), float(lon))
        else:
            pl = await resolve_place(db, city)
            dest = (pl.lat, pl.lon) if pl else None
        if not dest:
            return {"ok": False, "reason": "Location is outside the pandit\u2019s service area", "code": "RADIUS"}
        km = haversine_km(base[0], base[1], dest[0], dest[1])
        if km > p.radius_km:
            return {"ok": False, "reason": f"Location is {round(km)} km away, beyond the pandit\u2019s {p.radius_km} km service radius", "code": "RADIUS"}

    # Slot conflict LAST: the DB partial unique index remains the hard guarantee.
    if slot:
        clash = (await db.execute(
            select(Booking.id).where(
                Booking.pandit_id == p.id, Booking.date == date, Booking.slot == slot,
                Booking.status != "Cancelled", Booking.id != skip_id).limit(1))).scalar_one_or_none()
        if clash is not None:
            return {"ok": False, "reason": f"Already booked in the {slot} slot on this date", "code": "CONFLICT"}
    return {"ok": True, "reason": "Available", "code": "OK"}


async def is_free(db, p, date: str, slot: str, **kw) -> bool:
    return (await check(db, p, date, slot, **kw))["ok"]


async def auto_pick(db, puja_id: str, city: str | None, date: str, slot: str, *,
                    mode: str | None = None, lat=None, lon=None) -> Pandit | None:
    rows = (await db.execute(select(Pandit).where(Pandit.status == "verified"))).scalars().all()
    free = [p for p in rows if (await check(db, p, date, slot, mode=mode, city=city, lat=lat, lon=lon))["ok"]]

    def score(p: Pandit):
        return (puja_id in j(p.spec, []), p.city == city, p.rating or 0)
    free.sort(key=score, reverse=True)
    return free[0] if free else None


async def who_is_available(db, puja_id: str, city: str | None, date: str, slot: str, *,
                           mode: str | None = None, lat=None, lon=None) -> list[Pandit]:
    rows = (await db.execute(select(Pandit).where(Pandit.status == "verified"))).scalars().all()
    ok = [p for p in rows if (await check(db, p, date, slot, mode=mode, city=city, lat=lat, lon=lon))["ok"]]

    def score(p: Pandit):
        return (puja_id in j(p.spec, []), p.city == city, p.rating or 0)
    ok.sort(key=score, reverse=True)
    return ok


def config_of(p: Pandit) -> dict:
    """Availability configuration for the pandit portal / admin screens."""
    return {"weeklyOff": j(p.weekly_off, []), "slots": j(p.slots, []),
            "holidays": j(p.holidays, []), "blockedDates": j(p.blocked_dates, []),
            "radiusKm": p.radius_km, "baseLat": p.base_lat, "baseLon": p.base_lon,
            "onlineEnabled": bool(p.online_enabled), "templeEnabled": bool(p.temple_enabled)}
