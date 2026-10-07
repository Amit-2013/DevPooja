"""Row -> API shape. Port of server/lib/serialize.js — the browser app uses
these short field names, so parity here keeps the SPA working unchanged."""
import json
import re

from .util import j


def user(r) -> dict | None:
    if r is None:
        return None
    # accountType/location (additional-requirements Phase A, migration 029):
    # NRI is a property of the SAME account; location carries only what the
    # app needs (city, country, optional coordinates, how they were captured).
    return {"id": r.id, "n": r.name, "m": r.mobile or "", "e": r.email or "", "pts": r.pts,
            "plus": bool(r.plus), "addr": j(r.addr, []), "fam": j(r.fam, []),
            "pref": j(r.pref, {}), "joined": r.joined,
            "accountType": r.account_type or "normal", "location": j(r.location, {})}


def pandit(r, *, admin: bool = False, self: bool = False, flagged: bool = False) -> dict | None:
    if r is None:
        return None
    out = {"id": r.id, "n": r.name, "city": r.city, "exp": r.exp, "langs": j(r.langs, []),
           "spec": j(r.spec, []), "rating": r.rating, "rev": r.rev, "done": r.done,
           "pf": r.pf, "bio": r.bio or "", "color": r.color or "#0c4b49", "st": r.status,
           "feat": bool(r.featured), "off": j(r.off, []), "avail": bool(r.avail),
           "photo": "/media/" + r.photo_file if r.photo_file else "",
           "gotra": r.gotra or "", "quals": r.qualifications or "", "veda": r.veda_school or "",
           "qa": r.qa_score}
    # NOTE: derived cancellation/no-show metrics are NOT inlined here (they need an
    # async query); both backends expose them on the dedicated QA endpoints
    # (/admin/pandits/{id}/qa, /pandit/me/qa) which the portals use.
    if admin:
        out["m"] = r.mobile
        out["kyc"] = list((j(r.kyc, {}) or {}).get("files", {}).keys())
        out["flagged"] = bool(flagged)
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
            "created": r.created, "log": j(r.log, []), "refund": j(r.refund, None), "esc": bool(r.esc),
            "mediaOverride": bool(getattr(r, "media_override", 0)),
            # Per-pandit flagging follow-up: bookings of flagged pandits wait under a review hold.
            "reviewHold": bool(getattr(r, "review_hold", 0)),
            "holdReason": getattr(r, "hold_reason", None) or None,
            # Customer-conduct escalation: soft review flag on new bookings of flagged customers.
            "ch": r.customer_hold or 0, "chr": r.customer_hold_reason or None}


def puja(r, kit_items=None) -> dict:
    default_modes = ["home", "online", "temple", "custom"]
    try:
        modes = json.loads(r.modes or "[]")
        if not isinstance(modes, list) or not modes:
            modes = default_modes
    except (TypeError, ValueError):
        modes = default_modes
    return {"id": r.id, "n": r.name, "h": r.hindi, "cat": r.cat, "ic": r.icon, "dur": r.dur,
            "price": r.price, "deity": r.deity, "ben": r.ben, "benHi": r.ben_hi or "",
            "kit": r.kit, "pop": r.pop, "tags": r.tags, "hidden": bool(r.hidden),
            "sam": kit_items or [],
            # Phase 11: per-mode prices (None = legacy formula) + bookable modes
            "priceHome": getattr(r, "price_home", None),
            "priceOnline": getattr(r, "price_online", None),
            "priceTemple": getattr(r, "price_temple", None),
            "priceCustom": getattr(r, "price_custom", None),
            "modes": modes}


def kit(r) -> dict:
    return {"id": r.id, "n": r.name, "p": r.price, "ic": r.icon, "items": j(r.items, []),
            "active": r.active if r.active is not None else 1}


def prasad(r) -> dict:
    return {"id": r.id, "n": r.name, "p": r.price, "ic": r.icon, "d": r.descr,
            "stock": r.stock, "active": r.active if r.active is not None else 1}


def temple(r) -> dict:
    return {"id": r.id, "n": r.name, "city": r.city, "deity": r.deity, "ic": r.icon,
            "pujas": j(r.pujas, []), "off": r.offering, "d": r.descr,
            "active": r.active if getattr(r, "active", None) is not None else 1,
            "timings": r.timings or "", "photo": r.photo or ""}


def festival(r) -> dict:
    return {"id": r.id, "n": r.name, "d": r.date, "p": j(r.pujas, []), "t": r.note}


def order(r) -> dict:
    return {"id": r.id, "userId": r.user_id, "items": j(r.items, []), "total": r.total,
            "date": r.date, "st": r.status, "city": r.city, "coupon": r.coupon or "",
            "discount": r.discount or 0}


def ticket(r) -> dict:
    """Phase 19: the workflow service owns the ticket shape (normalised status +
    resolution + updated_at) so the state payload, the detail endpoint and the
    pandit list all speak the same words."""
    from .services.tickets import out
    return out(r)


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
            "active": bool(r.active), "used": r.used, "scope": r.scope or "ALL",
            "pujaId": r.puja_id or None, "starts": r.starts or None,
            "expires": r.expires or None, "per_user": r.per_user or 0}


def notif(r) -> dict:
    return {"id": r.id, "uid": r.user_id, "ch": r.channel, "m": r.message, "ts": r.ts,
            "r": bool(r.read_at)}


# Additional-requirements Phase B: our-people CMS rows. `person` is the full
# admin-managed profile (plus its category name for admin tables); `person_card`
# is the compact public listing shape that rides along in /state.
def people_category(r) -> dict:
    return {"id": r.id, "n": r.name, "order": r.sort_order or 0,
            "active": r.active if r.active is not None else 1, "created": r.created}


def _photo_url(name) -> str:
    return "/media/" + name if name else ""


def person(r, *, admin: bool = False) -> dict:
    out = {"id": r.id, "n": r.name, "designation": r.designation or "",
           "categoryId": r.category_id or "", "city": r.city or "", "country": r.country or "",
           "exp": r.experience or 0, "quals": r.qualifications or "",
           "expertise": j(r.expertise, []), "intro": r.intro or "", "bio": r.bio or "",
           "background": r.background or "", "sanatanWork": r.sanatan_work or "",
           "photo": _photo_url(r.photo_file), "photoThumb": _photo_url(r.photo_thumb),
           "photoWebp": _photo_url(r.photo_webp), "photoThumbWebp": _photo_url(r.photo_thumb_webp),
           "video": r.video_url or "", "socials": j(r.socials, []),
           "order": r.sort_order or 0, "active": r.active if r.active is not None else 1,
           "created": r.created, "updated": r.updated}
    if admin:
        out["categoryName"] = getattr(r, "category_name", "") or ""
    return out


def person_card(r) -> dict:
    return {"id": r.id, "n": r.name, "designation": r.designation or "",
            "categoryId": r.category_id or "", "city": r.city or "", "country": r.country or "",
            "exp": r.experience or 0, "intro": r.intro or "",
            "photo": _photo_url(r.photo_file), "photoThumb": _photo_url(r.photo_thumb),
            "order": r.sort_order or 0}


def person_photo(r) -> dict:
    return {"id": r.id, "url": _photo_url(r.filename), "thumb": _photo_url(r.thumb),
            "webp": _photo_url(r.webp), "thumbWebp": _photo_url(r.thumb_webp),
            "caption": r.caption or "", "order": r.sort_order or 0}


# Additional-requirements Phase D: gallery rows. `yt` is the YouTube id derived
# from the stored URL (empty for any other host), `thumb` the matching YouTube
# poster; the FE embeds only when `yt` is present and links out otherwise.
def yt_id(u) -> str:
    m = re.search(r"(?:youtube\.com/(?:watch\?v=|embed/|shorts/)|youtu\.be/)([A-Za-z0-9_-]{6,20})",
                  str(u or ""))
    return m.group(1) if m else ""


def gallery_album(r) -> dict:
    out = {"id": r.id, "n": r.name, "d": r.description or "", "order": r.sort_order or 0,
           "active": r.active if r.active is not None else 1,
           "created": r.created, "updated": r.updated,
           "photos": getattr(r, "photo_count", 0) or 0,
           "videos": getattr(r, "video_count", 0) or 0,
           "cover": "", "coverThumb": "", "coverWebp": "", "coverThumbWebp": ""}
    if getattr(r, "cover_filename", None):
        out["cover"] = _photo_url(r.cover_filename)
        out["coverThumb"] = _photo_url(getattr(r, "cover_thumb", None))
        out["coverWebp"] = _photo_url(getattr(r, "cover_webp", None))
        out["coverThumbWebp"] = _photo_url(getattr(r, "cover_thumb_webp", None))
    return out


def gallery_photo(r) -> dict:
    return {"id": r.id, "albumId": r.album_id or None, "url": _photo_url(r.filename),
            "thumb": _photo_url(r.thumb), "webp": _photo_url(r.webp),
            "thumbWebp": _photo_url(r.thumb_webp),
            "caption": r.caption or "", "altText": r.alt_text or "",
            "license": r.license or "", "credit": r.credit or "",
            "creditUrl": r.credit_url or "",
            "order": r.sort_order or 0, "active": r.active if r.active is not None else 1,
            "created": r.created, "updated": r.updated}


def gallery_video(r) -> dict:
    yt = yt_id(r.url)
    return {"id": r.id, "albumId": r.album_id or None, "n": r.title or "",
            "d": r.description or "", "url": r.url or "", "yt": yt,
            "thumb": ("https://i.ytimg.com/vi/" + yt + "/hqdefault.jpg") if yt else "",
            "order": r.sort_order or 0, "active": r.active if r.active is not None else 1,
            "created": r.created, "updated": r.updated}


# Phase 26: compact CRM lead row for the admin state payload.
def lead(r) -> dict:
    return {"id": r.id, "type": r.type, "n": r.name, "details": r.details or "",
            "date": r.date, "mobile": r.mobile or "", "email": r.email or "",
            "service": r.service or "", "location": r.location or "",
            "st": r.status or "NEW", "assignedTo": r.assigned_to or None,
            "followUpAt": r.follow_up_at or None,
            "convertedBookingId": r.converted_booking_id or None,
            "dupCount": r.dup_count or 0, "lastDupAt": r.last_dup_at or None}


def custom_request(r) -> dict:
    """Admin-queue row for a customized-puja request — twin of server/routes/
    admin.js crOut() (the workflow keeps both camelCase and the full history)."""
    return {"id": r.id, "userId": r.user_id, "name": r.name, "mobile": r.mobile,
            "language": r.language or "", "requirement": r.requirement or "",
            "purpose": r.purpose or "", "deity": r.deity or "", "occasion": r.occasion or "",
            "preferredDate": r.preferred_date or "", "preferredTime": r.preferred_time or "",
            "location": r.location or "", "city": r.city or "", "state": r.state or "",
            "country": r.country or "", "participants": r.participants, "budget": r.budget,
            "kundaliId": r.kundali_id or "", "doshCondition": r.dosh_condition or "",
            "remedy": r.remedy or "", "sankalp": r.sankalp or "",
            "samagriReq": r.samagri_req or "", "notes": r.notes or "",
            "attachments": j(r.attachments, []), "status": r.status,
            "adminNotes": r.admin_notes or "", "panditNotes": r.pandit_notes or "",
            "quoteAmount": r.quote_amount, "finalPrice": r.final_price,
            "paymentStatus": r.payment_status or "", "assignedPanditId": r.assigned_pandit_id,
            "assignedTempleId": r.assigned_temple_id, "bookingId": r.booking_id or "",
            "pujaId": r.puja_id, "history": j(r.history, []),
            "createdAt": r.created_at, "updatedAt": r.updated_at}
