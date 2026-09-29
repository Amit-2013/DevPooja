"""Port of shared/pricing.js — the single source of truth for booking pricing.
The server ALWAYS recomputes; the browser is never trusted.

Parity note: JavaScript Math.round is round-half-up; Python's round() is
banker's rounding. Every Math.round here goes through js_round() so totals
match the Node engine (and the frontend, which shares pricing.js) exactly."""
import math
import re
import time
from datetime import datetime, timedelta

MODES = {
    "home":   {"n": "Home Puja",         "i": "🏠", "f": 1.0, "d": "The pandit comes to your home"},
    "online": {"n": "Online Video Puja", "i": "📹", "f": 0.7, "d": "Live video call with your sankalp read out"},
    "temple": {"n": "Temple Puja",       "i": "🛕", "f": 0.9, "d": "Performed at a partner temple on your behalf"},
    "custom": {"n": "Customized Puja",   "i": "🎨", "f": 1.4, "d": "Extended rituals, special mantras, your own requirements"},
}
SLOTS = ["06:00 AM", "08:00 AM", "10:00 AM", "12:00 PM", "02:00 PM", "04:00 PM", "06:00 PM"]
TEMPLE_OFFERING = 251
CONVENIENCE_FEE = 99
DELIVERY_FEE = 49
FREE_DELIVERY_ABOVE = 999
GST_SERVICE = 0.18
GST_GOODS = 0.05
POINT_VALUE = 0.5
MAX_POINTS_SHARE = 0.3


def js_round(x: float) -> int:
    """JavaScript Math.round: round-half-up for positive values."""
    return int(math.floor(x + 0.5))


def quote(mode: str, ctx: dict) -> dict:
    """ctx: { puja:{price}, pandit:{pf}|None, plus:bool, kits:[{price}],
    prasad:[{price}], coupon|None, points:int, usePoints:bool,
    modePrice:int|None (Phase 11: explicit per-mode price — FLAT, the pandit
    pf multiplier does not apply) }"""
    if mode not in MODES:
        raise ValueError("Unknown mode")
    puja, pd = ctx["puja"], ctx.get("pandit")
    if ctx.get("modePrice") is not None:
        svc = js_round(ctx["modePrice"])
    else:
        svc = js_round((puja["price"] * MODES[mode]["f"] * (pd["pf"] if pd else 1)) / 10) * 10
    tmp = TEMPLE_OFFERING if mode == "temple" else 0
    plus = bool(ctx.get("plus"))
    conv = 0 if plus else CONVENIENCE_FEE
    sam = sum(k["price"] for k in (ctx.get("kits") or []))
    pra = sum(k["price"] for k in (ctx.get("prasad") or []))
    dele = DELIVERY_FEE if (sam + pra > 0 and not plus and sam + pra < FREE_DELIVERY_ABOVE) else 0
    disc = 0
    c = ctx.get("coupon")
    if c and c.get("active") and svc >= c.get("min", 0):
        disc = js_round(min((svc * c["val"]) / 100, c["max"]) if c["type"] == "pct" else c["val"])
    rd = pts = 0
    if ctx.get("usePoints") and ctx.get("points", 0) > 0:
        rd = js_round(min(ctx["points"] * POINT_VALUE, (svc - disc) * MAX_POINTS_SHARE))
        pts = js_round(rd / POINT_VALUE)
    base = svc + tmp + conv - disc - rd
    gst = js_round(base * GST_SERVICE + (sam + pra) * GST_GOODS)
    total = base + sam + pra + dele + gst
    return {"svc": svc, "tmp": tmp, "conv": conv, "sam": sam, "pra": pra, "del": dele,
            "disc": disc, "rd": rd, "pts": pts, "gst": gst, "total": total,
            "earn": (total // 100) * (2 if plus else 1)}


def coupon_problem(c, svc: int, x: dict | None = None) -> str:
    # Phase 14: validity beyond active+minimum — scope, per-puja, time window,
    # per-user cap. x (all optional): scope/pujaId = which surface is asking,
    # now = wall clock, usedByUser = redemptions this user already has.
    if not c or not c.get("active"):
        return "Coupon not found or inactive."
    x = x or {}
    now = x.get("now") or int(time.time() * 1000)
    if c.get("starts") and now < c["starts"]:
        return "This coupon is not active yet."
    if c.get("expires") and now >= c["expires"]:
        return "This coupon has expired."
    scope = c.get("scope") or "ALL"
    if x.get("scope") and scope != "ALL" and scope != x["scope"]:
        return ("This coupon does not apply to kundali purchases"
                if x["scope"] == "KUNDALI" else
                "This coupon does not apply to this purchase.")
    if x.get("pujaId") and c.get("pujaId") and c["pujaId"] != x["pujaId"]:
        return "This coupon applies to a different puja."
    if svc < c.get("min", 0):
        return f"Needs a puja value of at least Rs {c['min']}."
    if c.get("per_user") and x.get("usedByUser") is not None and x["usedByUser"] >= c["per_user"]:
        return "You have already used this coupon the maximum number of times."
    return ""


def refund_pct(hours_to_puja: float) -> int:
    """Refund tier by hours before the puja: >48h 100%, 24-48h 75%, else 50%."""
    return 100 if hours_to_puja > 48 else (75 if hours_to_puja > 24 else 50)


def slot_date(date: str, slot: str) -> datetime:
    m = re.search(r"(\d+):(\d+) (AM|PM)", slot or "")
    if not m:
        raise ValueError("Bad slot")
    h = (int(m.group(1)) % 12) + (12 if m.group(3) == "PM" else 0)
    d = datetime.fromisoformat(date + "T12:00:00")
    return d.replace(hour=h, minute=int(m.group(2)), second=0, microsecond=0)


def hours_until(date: str, slot: str, now: datetime | None = None) -> float:
    return (slot_date(date, slot) - (now or datetime.now())).total_seconds() / 3600.0
