"""Row -> API shape. Port of server/lib/serialize.js — the browser app uses
these short field names, so parity here keeps the SPA working unchanged."""
import json

from .util import j


def user(r) -> dict | None:
    if r is None:
        return None
    return {"id": r.id, "n": r.name, "m": r.mobile or "", "e": r.email or "", "pts": r.pts,
            "plus": bool(r.plus), "addr": j(r.addr, []), "fam": j(r.fam, []),
            "pref": j(r.pref, {}), "joined": r.joined}


def pandit(r, *, admin: bool = False, self: bool = False) -> dict | None:
    if r is None:
        return None
    out = {"id": r.id, "n": r.name, "city": r.city, "exp": r.exp, "langs": j(r.langs, []),
           "spec": j(r.spec, []), "rating": r.rating, "rev": r.rev, "done": r.done,
           "pf": r.pf, "bio": r.bio or "", "color": r.color or "#0c4b49", "st": r.status,
           "feat": bool(r.featured), "off": j(r.off, []), "avail": bool(r.avail)}
    if admin:
        out["m"] = r.mobile
        out["kyc"] = list((j(r.kyc, {}) or {}).get("files", {}).keys())
    if admin or self:
        from .services.availability import config_of
        out["av"] = config_of(r)
    return out


def booking(r) -> dict:
    media = j(r.media, [])
    return {"id": r.id, "userId": r.user_id, "pujaId": r.puja_id, "mode": r.mode,
            "date": r.date, "slot": r.slot, "addr": j(r.addr, None), "templeId": r.temple_id,
            "panditId": r.pandit_id, "pst": r.pst, "sam": j(r.sam, []), "pra": j(r.pra, []),
            "notes": r.notes or "", "member": r.member or "Self", "coupon": r.coupon or "",
            "q": j(r.q, {}), "status": r.status, "pay": j(r.pay, {}), "ops": j(r.ops, {}),
            "media": len(media), "mediaUrls": media, "review": j(r.review, None),
            "created": r.created, "log": j(r.log, []), "refund": j(r.refund, None), "esc": bool(r.esc)}


def puja(r, kit_items=None) -> dict:
    return {"id": r.id, "n": r.name, "h": r.hindi, "cat": r.cat, "ic": r.icon, "dur": r.dur,
            "price": r.price, "deity": r.deity, "ben": r.ben, "benHi": r.ben_hi or "",
            "kit": r.kit, "pop": r.pop, "tags": r.tags, "hidden": bool(r.hidden),
            "sam": kit_items or []}


def kit(r) -> dict:
    return {"id": r.id, "n": r.name, "p": r.price, "ic": r.icon, "items": j(r.items, []),
            "active": r.active if r.active is not None else 1}


def prasad(r) -> dict:
    return {"id": r.id, "n": r.name, "p": r.price, "ic": r.icon, "d": r.descr,
            "stock": r.stock, "active": r.active if r.active is not None else 1}


def temple(r) -> dict:
    return {"id": r.id, "n": r.name, "city": r.city, "deity": r.deity, "ic": r.icon,
            "pujas": j(r.pujas, []), "off": r.offering, "d": r.descr}


def festival(r) -> dict:
    return {"id": r.id, "n": r.name, "d": r.date, "p": j(r.pujas, []), "t": r.note}


def order(r) -> dict:
    return {"id": r.id, "userId": r.user_id, "items": j(r.items, []), "total": r.total,
            "date": r.date, "st": r.status, "city": r.city}


def ticket(r) -> dict:
    return {"id": r.id, "userId": r.user_id, "b": r.booking_id or "", "t": r.text,
            "st": r.status, "prio": r.prio}


def payout(r) -> dict:
    """Payout shape: canonical statuses (Phases 7-8), hold info, money trail, refs.
    Twin of server/lib/serialize.js payout()."""
    from .services.payout_engine import legacy_status  # noqa: F401  (kept for parity)

    return {"id": r.id, "p": r.pandit_id, "amt": r.amount, "date": r.date,
            "st": legacy_status(r.status), "b": r.booking_id,
            "gross": r.gross_amount if r.gross_amount is not None else r.amount,
            "comm": r.commission_amt, "tax": r.tax_amt or 0, "refd": r.refund_amt or 0,
            "adj": r.adjustment_amt or 0, "cur": r.currency or "INR",
            "hr": r.hold_reason or None, "hn": r.hold_note or None,
            "pd": r.processing_date or None, "dd": r.disbursement_date or None,
            "pr": r.payment_ref or None, "utr": r.utr or None}


def coupon(r) -> dict:
    return {"code": r.code, "type": r.type, "val": r.val, "max": r.max, "min": r.min,
            "active": bool(r.active), "used": r.used}


def notif(r) -> dict:
    return {"id": r.id, "uid": r.user_id, "ch": r.channel, "m": r.message, "ts": r.ts}
