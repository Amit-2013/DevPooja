"""Kundali -> Dosh -> Recommendation flow — port of server/routes/kundali.js, with
the commercial model and the family-member routes (which previously lived in
server/routes/customer.js; the Python customer router defers them to this module).

Kundali endpoints (prefix /api/kundali):
  GET  /places?q=delhi        searchable birth-place index
  GET  /conditions            public condition metadata (bilingual)
  GET  /catalog               havan kunds + samagri items
  GET  /pricing               current pricing + the user's quota (auth-aware)
  POST /quote                 quote for a family/additional kundali (customer)
  POST /pay/verify            verify payment for a PENDING_PAYMENT kundali (customer)
  POST /generate              build the chart, run dosh analysis, recommend pujas
  GET  /mine                  the customer's kundalis + quota (customer)
  GET  /{id}                  fetch a saved kundali + its analysis

Family-member endpoints (Node parity: /api/me/family on the customer router):
  GET  /me/family             list family members
  POST /me/family             add one (max 20)
  PATCH /me/family/{id}       update
  DELETE /me/family/{id}      remove

All astrology runs through services/astrology (real ephemeris, no fake data).
/generate writes kundalis, dosh_analysis and puja_recommendations rows only."""
import json
import math
import os
import re
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..models import (ConditionPujaRule, DoshAnalysis, FamilyMember, HavanKund,
                      Kundali, KundaliActivity, KundaliCondition, KundaliProfile,
                      PlaceIndex, Puja, PujaKund, PujaRecommendation, PujaSamagri,
                      SamagriItem, User)
from ..security import AuthError, current_auth, require_role
from ..services import astrology as astro
from ..services import kundali_billing as KB
from ..services import payments as pay
from ..util import bad, http_error, j, rid, v_date, v_email, v_int, v_one_of, v_str

router = APIRouter(prefix="/api/kundali", tags=["kundali"])
customer_dep = require_role("customer")

ENGINE_VERSION = "internal-ephemeris-v1"
PURPOSES = ['General', 'Marriage', 'Career', 'Business', 'Health & Wellness', 'Finance', 'Education', 'Family', 'Child', 'Spiritual', 'Property', 'Other']
ACCURACIES = ['exact', 'approximate', 'unknown']
RELATIONSHIPS = ['Father', 'Mother', 'Spouse', 'Son', 'Daughter', 'Brother', 'Sister', 'Grandfather', 'Grandmother', 'Other']

# Expensive endpoints: hard limit BEFORE the ephemeris runs (15 / 15 min / user-or-IP).
_GEN_WINDOW_MS = 15 * 60 * 1000
_GEN_LIMIT = 15
_hits: dict[str, list[float]] = {}


def _rate_limited(auth: dict | None, request: Request) -> bool:
    # Node parity: skipped in test mode so the suite can hammer /generate.
    if os.environ.get("NODE_ENV") == "test" or os.environ.get("ENVIRONMENT") == "test":
        return False
    key = ("u:" + auth["uid"]) if auth and auth.get("uid") else "ip:" + (request.client.host if request.client else "?")
    now = time.time() * 1000
    wins = [t for t in _hits.get(key, []) if now - t < _GEN_WINDOW_MS]
    if len(wins) >= _GEN_LIMIT:
        _hits[key] = wins
        return True
    wins.append(now)
    _hits[key] = wins
    return False


def utc_offset_for(tz: str, utc: datetime | None) -> str:
    """Structured birth place for the API/UI. utcOffset is derived from the stored
    IANA zone at the birth instant (IST stays a fixed +05:30, matching the engine)."""
    z = str(tz or "")
    if re.search(r"Kolkata|Calcutta|Asia/India|IST", z, re.I):
        return "UTC+05:30"
    if not z:
        return ""
    try:
        at = utc or datetime.now(timezone.utc)
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        from zoneinfo import ZoneInfo
        wall = at.astimezone(ZoneInfo(z))
        off_min = round((wall.timestamp() - at.timestamp()) / 60)
        sign = "+" if off_min >= 0 else "-"
        a = abs(off_min)
        return f"UTC{sign}{a // 60:02d}:{a % 60:02d}"
    except Exception:
        return ""


def place_object(p: dict, utc: datetime | None) -> dict:
    return {
        "city": p.get("city") or "", "state": p.get("state") or "", "country": p.get("country") or "",
        "lat": p.get("lat"), "lon": p.get("lon"), "tz": p.get("tz") or "",
        "utcOffset": utc_offset_for(p.get("tz"), utc),
    }


def _finite(x) -> float | None:
    try:
        n = float(x)
        return n if math.isfinite(n) else None
    except (TypeError, ValueError):
        return None


def _parse_utc_iso(s):
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue
    return None


# --- GET /places?q= -----------------------------------------------------------
@router.get("/places")
async def places(q: str = "", db: AsyncSession = Depends(get_db)):
    q = str(q or "").strip()
    if len(q) < 2:
        return {"places": []}
    like = "%" + q.replace("%", "").replace("_", "") + "%"
    rows = (await db.execute(
        select(PlaceIndex)
        .where((PlaceIndex.city.like(like)) | (PlaceIndex.state.like(like)))
        .order_by(PlaceIndex.population.desc(), PlaceIndex.city)
        .limit(8))).scalars().all()
    return {"places": [{
        "id": r.id,
        "label": ", ".join(x for x in [r.city, r.state, r.country] if x),
        "city": r.city, "state": r.state, "country": r.country,
        "lat": r.lat, "lon": r.lon, "tz": r.tz,
        "utcOffset": utc_offset_for(r.tz, None),
    } for r in rows]}


# --- GET /conditions + /catalog: public metadata for the kundali UI -----------
@router.get("/conditions")
async def conditions(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(KundaliCondition).where(KundaliCondition.active == 1)
        .order_by(KundaliCondition.severity.desc(), KundaliCondition.name))).scalars().all()
    return {"conditions": [{
        "code": r.code, "name": r.name, "nameHi": r.name_hi, "descr": r.descr,
        "descrHi": r.descr_hi, "remedy": r.remedy, "remedyHi": r.remedy_hi,
        "severity": r.severity,
    } for r in rows]}


@router.get("/catalog")
async def catalog(db: AsyncSession = Depends(get_db)):
    kunds = (await db.execute(
        select(HavanKund).where(HavanKund.active == 1).order_by(HavanKund.price))).scalars().all()
    items = (await db.execute(
        select(SamagriItem).where(SamagriItem.active == 1).order_by(SamagriItem.name))).scalars().all()
    return {"kunds": [{"id": k.id, "name": k.name, "material": k.material,
                       "size": k.size_in, "price": k.price, "descr": k.descr} for k in kunds],
            "items": [{"id": i.id, "name": i.name, "unit": i.unit, "category": i.category} for i in items]}


# --- GET /pricing --------------------------------------------------------------
@router.get("/pricing")
async def pricing(auth: dict | None = Depends(current_auth), db: AsyncSession = Depends(get_db)):
    p = await KB.pricing(db)
    u = None
    if auth and auth["role"] == "customer":
        u = await db.get(User, auth["uid"])
    quota = None
    if u:
        inc = await KB.included_count(db, u)
        used = await KB.used_count(db, u.id)
        quota = {"included": inc, "used": used, "remaining": max(0, inc - used)}
    return {
        "active": p["active"], "currency": p["currency"], "gstPct": p["gstPct"],
        "discountPct": p["discountPct"], "couponEligible": p["couponEligible"],
        "prices": {"personal": p["personalPrice"], "family": p["familyPrice"],
                   "additional": p["additionalPrice"]},
        "freeCounts": p["freeCounts"],
        "quota": quota,
    }


# --- POST /quote (customer) -----------------------------------------------------
@router.post("/quote")
async def quote(body: dict, auth: dict = Depends(customer_dep),
                db: AsyncSession = Depends(get_db)):
    b = body or {}
    u = await db.get(User, auth["uid"])
    q = await KB.quote_for(db, u, relationship=b.get("relationship"), coupon=b.get("coupon"))
    return {"quote": q}


# --- POST /pay/verify (customer): flip PENDING_PAYMENT -> PAID -------------------
@router.post("/pay/verify")
async def pay_verify(body: dict, auth: dict = Depends(customer_dep),
                     db: AsyncSession = Depends(get_db)):
    b = body or {}
    kid = str(b.get("kundaliId") or "")
    k = await db.get(Kundali, kid)
    if not k or k.customer_id != auth["uid"]:
        raise http_error(404, "Kundali not found")
    if k.billing in ("PAID", "FREE"):
        return {"ok": True, "billing": k.billing}
    if k.billing != "PENDING_PAYMENT":
        raise bad("This kundali is not awaiting payment")
    sig = b if b.get("razorpay_signature") else {
        "razorpay_order_id": b.get("razorpay_order_id"),
        "razorpay_payment_id": b.get("razorpay_payment_id"),
        "razorpay_signature": b.get("razorpay_signature"),
    }
    if pay.mode() == "razorpay":
        if k.order_id != sig.get("razorpay_order_id") or not pay.verify_signature(
                sig.get("razorpay_order_id"), sig.get("razorpay_payment_id"),
                sig.get("razorpay_signature")):
            raise bad("Payment verification failed")
    info = {"ok": True, "kundaliId": kid, "billing": "PAID"}
    pid = (str(sig.get("razorpay_payment_id"))[:60] if pay.mode() == "razorpay" else "MOCK" + rid(4))
    await db.execute(update(Kundali).where(Kundali.id == kid)
                     .values(billing="PAID", payment_status="Paid", payment_id=pid))
    await KB.idem_put(db, b.get("idemKey"), "kundali.pay", info)
    await db.flush()
    return info


# --- POST /generate --------------------------------------------------------------
# Body: { name, gender, dob, tob?, birthTimeAccuracy?, placeId? | place{...},
#         email?, mobile?, gotra?, purpose?, save?, relationship?|familyMemberId?,
#         idemKey?, coupon? }
# Billing: personal kundalis within the plan quota are FREE; family/additional are
# PENDING_PAYMENT until /pay/verify (mock mode completes instantly).
@router.post("/generate")
async def generate(body: dict, request: Request,
                   auth: dict | None = Depends(current_auth),
                   db: AsyncSession = Depends(get_db)):
    if _rate_limited(auth, request):
        return JSONResponse(status_code=429, content={
            "error": "Too many Kundali generation requests. Please try again later."})
    b = body or {}
    # Commercial classification happens first: a family-member request takes its
    # details from the family_members row, so personal fields become optional.
    user = None
    if auth and auth["role"] == "customer":
        user = await db.get(User, auth["uid"])
    family_member_id = None
    relationship = ""
    if b.get("familyMemberId"):
        if not user:
            raise AuthError(401, "Please log in to create a family member kundali")
        fm = (await db.execute(select(FamilyMember).where(
            FamilyMember.id == str(b["familyMemberId"]),
            FamilyMember.customer_id == user.id))).scalar_one_or_none()
        if not fm:
            raise bad("Family member not found")
        family_member_id = fm.id
        relationship = fm.relationship
        if fm.name:
            b["name"] = fm.name
        if fm.gender:
            b["gender"] = fm.gender
        if fm.dob:
            b["dob"] = fm.dob
        if fm.tob:
            b["tob"] = fm.tob
        if b.get("save") is None:
            b["save"] = True
    elif b.get("relationship"):
        if not user:
            raise AuthError(401, "Please log in to create a family member kundali")
        relationship = v_one_of(b.get("relationship"), RELATIONSHIPS, "Relationship")

    name = v_str(b.get("name"), "Name", max_len=80)
    gender = v_one_of(b.get("gender"), ["male", "female", "other"], "Gender") if b.get("gender") else ""
    dob = v_date(b.get("dob"), "Date of birth")
    try:
        if datetime.strptime(dob + "T12:00:00", "%Y-%m-%dT%H:%M:%S") > datetime.now():
            raise bad("Date of birth cannot be in the future")
    except ValueError:
        raise bad("Date of birth is invalid")
    tob = v_str(b.get("tob"), "Time of birth", max_len=8) if b.get("tob") else ""
    if tob and not re.fullmatch(r"\d{1,2}:\d{2}", tob):
        raise bad("Time of birth must be HH:MM (24-hour)")
    accuracy = (v_one_of(b.get("birthTimeAccuracy"), ACCURACIES, "Birth time accuracy")
                if b.get("birthTimeAccuracy") else ("exact" if tob else "unknown"))

    # Idempotency: a repeated request (same key) returns the original result.
    idem_key = str(b.get("idemKey"))[:120] if b.get("idemKey") else ""
    prior = await KB.idem_get(db, idem_key, "kundali.generate")
    if prior:
        return prior  # Node parity: 200 on replay

    # place: either a saved place_index id or raw coordinates
    if b.get("placeId"):
        row = await db.get(PlaceIndex, v_int(b.get("placeId"), "Place"))
        if not row:
            raise bad("Unknown birth place. Search again and pick a location from the list.")
        place = {"city": row.city, "state": row.state, "country": row.country,
                 "lat": row.lat, "lon": row.lon, "tz": row.tz}
    elif isinstance(b.get("place"), dict) and _finite(b["place"].get("lat")) is not None \
            and _finite(b["place"].get("lon")) is not None:
        p = b["place"]
        place = {
            "city": v_str(p.get("city"), "City", max_len=80),
            "state": v_str(p.get("state") or "", "State", optional=True, max_len=80),
            "country": v_str(p.get("country") or "India", "Country", max_len=80),
            "lat": max(-90.0, min(90.0, _finite(p["lat"]))),
            "lon": max(-180.0, min(180.0, _finite(p["lon"]))),
            "tz": v_str(p.get("tz") or "Asia/Kolkata", "Time zone", max_len=40),
        }
    else:
        raise bad("Choose a birth place from the list (search by city).")

    email = v_email(b.get("email")) if b.get("email") else ""
    mobile = re.sub(r"\D", "", str(b.get("mobile") or ""))[-10:] if b.get("mobile") else ""
    gotra = v_str(b.get("gotra"), "Gotra", optional=True, max_len=40) if b.get("gotra") else ""
    purpose = v_one_of(b.get("purpose"), PURPOSES, "Purpose") if b.get("purpose") else "General"

    # A family member's saved place wins over the request's placeId.
    if family_member_id:
        fm2 = await db.get(FamilyMember, family_member_id)
        if fm2 and fm2.lat is not None:
            place = {"city": fm2.city or place["city"], "state": fm2.state or place["state"],
                     "country": fm2.country or place["country"], "lat": fm2.lat, "lon": fm2.lon,
                     "tz": fm2.tz or place["tz"]}

    bill = (await KB.classify(db, user, relationship) if user
            else {"family": bool(relationship), "included": False, "base": 0, "label": "Guest"})
    quote = (await KB.quote_for(db, user, relationship=relationship, coupon=b.get("coupon"))
             if user and bill["base"] > 0 else None)
    base = quote["base"] if quote else bill["base"]
    chargeable = bool(user) and base > 0
    gateway = pay.mode() == "razorpay"
    billing = ("PENDING_PAYMENT" if gateway else "PAID") if chargeable else "FREE"

    # 1. generate the kundali (real ephemeris)
    try:
        chart = astro.build_chart({
            "name": name, "gender": gender, "dob": dob, "tob": tob, "birthTimeAccuracy": accuracy,
            "lat": place["lat"], "lon": place["lon"], "tz": place["tz"],
            "place": ", ".join(x for x in [place["city"], place["state"], place["country"]] if x),
            "city": place["city"], "state": place["state"], "country": place["country"],
        })
    except ValueError as e:
        raise bad("Could not generate the kundali: " + str(e))

    # 2. dosh analysis (rule engine over the chart)
    results = await astro.analyze(db, chart)
    found = astro.detected(results)

    # 3. puja / havan / samagri recommendations (DB-driven)
    recs = await astro.recommendations_for(db, found, purpose=purpose)
    havans = await astro.havan_for(db, [r["pujaId"] for r in recs])
    samagri = await astro.samagri_for(db, [r["pujaId"] for r in recs])

    # 4. persist (guest-friendly; attached to the logged-in user when there is one)
    user_id = user.id if user else None
    kundali_id = "K" + rid(6)
    order_id = "KDO" + rid(5) if chargeable else ""
    profile_id = None
    if b.get("save"):
        profile_id = "kp" + rid(5)
        db.add(KundaliProfile(
            id=profile_id, user_id=user_id, name=name, gender=gender or None, dob=dob, tob=tob,
            pob=place["city"], lat=place["lat"], lon=place["lon"], tz=place["tz"],
            state=place["state"] or "", country=place["country"] or "",
            birth_time_accuracy=accuracy, purpose=purpose, email=email, mobile=mobile,
            gotra=gotra,
            whatsapp=(re.sub(r"\D", "", str(b.get("whatsapp")))[-10:] if b.get("whatsapp") else ""),
            created_at=KB.now_ms()))
    qd = quote if quote else {"base": base, "discount": 0, "gst": 0, "final": 0, "currency": "INR"}
    db.add(Kundali(
        id=kundali_id, profile_id=profile_id, name=name,
        chart_data=json.dumps(chart, ensure_ascii=False),
        planetary_data=json.dumps(astro.analysis_view(chart), ensure_ascii=False),
        lagna=chart["lagna"]["signName"], rashi=chart["rashi"]["signName"],
        nakshatra=chart["panchang"]["nakshatra"], pada=chart["planets"]["moon"]["nakshatra"]["pada"],
        dasha_data=json.dumps(chart["dashas"]), navamsa_data=json.dumps(chart["navamsaSigns"]),
        calculation_version=ENGINE_VERSION,
        customer_id=user_id, family_member_id=family_member_id, relationship=relationship or "",
        billing=billing, price=qd["base"], discount=qd["discount"], gst=qd["gst"],
        final_amount=qd["final"], currency=qd.get("currency") or "INR",
        order_id=order_id,
        payment_status=("Paid" if billing == "PAID" else "Pending") if chargeable
        else ("Free" if billing == "FREE" else ""),
        payment_id=("MOCK" + rid(4)) if billing == "PAID" else "",
        idem_key=idem_key, created_at=KB.now_ms()))

    for r in results:
        cond = await db.get(KundaliCondition, r["code"])
        db.add(DoshAnalysis(
            kundali_id=kundali_id, dosh_type=r["code"], detected=1 if r["detected"] else 0,
            severity=r["severity"], confidence=r["confidence"], explanation=r["explanation"],
            evidence=json.dumps(r["evidence"], ensure_ascii=False),
            evidence_hi=json.dumps(r.get("evidenceHi") or [], ensure_ascii=False),
            recommendation=(cond.remedy if cond else "") or "", created_at=KB.now_ms()))
    for r in recs:
        db.add(PujaRecommendation(
            kundali_id=kundali_id, puja_id=r["pujaId"], recommendation_reason=r["reason"],
            priority=r["priority"], relevance_score=r["weight"],
            related_doshas=json.dumps(r["relatedDoshas"]), reason_hi=r.get("reasonHi") or "",
            created_at=KB.now_ms()))
    db.add(KundaliActivity(
        user_id=user_id, action="kundali.generate",
        detail=json.dumps({"kundaliId": kundali_id, "detected": len(found),
                           "recommendations": len(recs), "billing": billing}),
        created_at=KB.now_ms()))
    await db.flush()

    # Razorpay order for chargeable kundalis in gateway mode.
    payment = None
    if billing == "PENDING_PAYMENT":
        try:
            payment = await pay.create_order(quote["final"], kundali_id)
        except Exception as e:
            raise http_error(502, "Payment gateway error: " + str(e))
        await db.execute(update(Kundali).where(Kundali.id == kundali_id).values(order_id=payment["orderId"]))

    # 5. response: the full flow result for the result page
    order = {"high": 0, "medium": 1, "low": 2, "none": 3}
    payload = {
        "kundaliId": kundali_id,
        "place": place_object(place, _parse_utc_iso(chart["meta"]["utcIso"])),
        "chart": chart,
        "analysis": {"engine": ENGINE_VERSION,
                     "doshas": sorted(results, key=lambda r: order.get(r["severity"], 9)),
                     "detectedCount": len(found)},
        "recommendations": recs,
        "havans": havans,
        "samagri": samagri,
        "billing": {"state": billing, "label": bill["label"], "included": bill["included"],
                    "family": bill["family"], "price": base,
                    "discount": quote["discount"] if quote else 0,
                    "gst": quote["gst"] if quote else 0,
                    "final": quote["final"] if quote else 0,
                    "currency": quote["currency"] if quote else "INR",
                    "orderId": order_id, "payment": payment},
        "disclaimer": "This analysis follows traditional Jyotish rules on your birth details. It is offered for spiritual guidance and is not a prediction or guarantee of any future event.",
        "disclaimerHi": "यह विश्लेषण आपकी जन्म विवरणों पर पारंपरिक ज्योतिष नियमों के अनुसार है। यह आध्यात्मिक मार्गदर्शन हेतु है — यह किसी भी भविष्य की घटना की भविष्यवाणी या गारंटी नहीं है।",
    }
    if idem_key and billing != "PENDING_PAYMENT":
        await KB.idem_put(db, idem_key, "kundali.generate", {"kundaliId": kundali_id, "billing": billing})
    return JSONResponse(status_code=201, content=payload)


# --- GET /mine (customer) --------------------------------------------------------
@router.get("/mine")
async def mine(auth: dict = Depends(customer_dep), db: AsyncSession = Depends(get_db)):
    u = await db.get(User, auth["uid"])
    rows = (await db.execute(
        select(Kundali).where(Kundali.customer_id == u.id)
        .order_by(Kundali.created_at.desc()))).scalars().all()
    inc = await KB.included_count(db, u)
    used = await KB.used_count(db, u.id)
    return {
        "quota": {"included": inc, "used": used, "remaining": max(0, inc - used)},
        "kundalis": [{
            "kundaliId": r.id, "name": r.name, "relationship": r.relationship or "Self",
            "billing": r.billing, "price": r.price, "discount": r.discount, "gst": r.gst,
            "final": r.final_amount, "currency": r.currency, "paymentStatus": r.payment_status,
            "orderId": r.order_id, "paymentId": r.payment_id, "createdAt": r.created_at,
        } for r in rows],
    }


# --- GET /{id} (KEEP LAST — same catch-all ordering rule as Node's Express) --------
@router.get("/{kid}")
async def get_kundali(kid: str, auth: dict | None = Depends(current_auth),
                      db: AsyncSession = Depends(get_db)):
    if not re.fullmatch(r"K[a-f0-9]{12}", kid):
        raise http_error(404, "Kundali not found")
    k = await db.get(Kundali, kid)
    if not k:
        raise http_error(404, "Kundali not found")
    # Ownership: a logged-in user may only open their own kundali; admins (and pandits
    # with an assigned booking) may open any. Guests may only use unclaimed links.
    if auth and auth["role"] == "customer" and k.customer_id and k.customer_id != auth["uid"]:
        raise http_error(404, "Kundali not found")
    dosha_rows = (await db.execute(select(DoshAnalysis).where(
        DoshAnalysis.kundali_id == k.id))).scalars().all()
    doshas = [{
        "code": r.dosh_type, "detected": bool(r.detected), "severity": r.severity,
        "confidence": r.confidence, "explanation": r.explanation,
        "evidence": j(r.evidence, []), "evidenceHi": j(r.evidence_hi, []),
        "recommendation": r.recommendation,
    } for r in dosha_rows]
    rec_rows = (await db.execute(
        select(PujaRecommendation, Puja)
        .join(Puja, Puja.id == PujaRecommendation.puja_id, isouter=True)
        .where(PujaRecommendation.kundali_id == k.id)
        .order_by(PujaRecommendation.priority, PujaRecommendation.relevance_score.desc()))).all()
    recs = [{
        "pujaId": pr.puja_id, "name": (p.name if p else None), "icon": (p.icon if p else None),
        "priority": pr.priority, "reason": pr.recommendation_reason,
        "reasonHi": pr.reason_hi or "", "weight": pr.relevance_score,
        "relatedDoshas": j(pr.related_doshas, []),
    } for pr, p in rec_rows]
    chart = j(k.chart_data, {})
    prof = await db.get(KundaliProfile, k.profile_id) if k.profile_id else None
    meta = (chart or {}).get("meta") or {}
    if meta.get("lat") is not None:
        place = place_object({
            "city": meta.get("city") or (prof.pob if prof else ""),
            "state": meta.get("state") or (prof.state if prof else ""),
            "country": meta.get("country") or (prof.country if prof else ""),
            "lat": meta["lat"], "lon": meta["lon"], "tz": meta.get("tz"),
        }, _parse_utc_iso(meta.get("utcIso")))
    elif prof:
        place = place_object({"city": prof.pob, "state": prof.state, "country": prof.country,
                              "lat": prof.lat, "lon": prof.lon, "tz": prof.tz}, None)
    else:
        place = None
    return {
        "kundaliId": k.id, "name": k.name, "lagna": k.lagna, "rashi": k.rashi,
        "nakshatra": k.nakshatra, "pada": k.pada,
        "billing": {"state": k.billing, "relationship": k.relationship or "Self",
                    "final": k.final_amount, "currency": k.currency,
                    "paymentStatus": k.payment_status},
        "place": place, "chart": chart,
        "dashas": j(k.dasha_data, {}), "navamsa": j(k.navamsa_data, {}),
        "doshas": doshas, "recommendations": recs, "engine": k.calculation_version,
    }


# --- family members (Node: /api/me/family on the customer router) ------------------
fm_router = APIRouter(prefix="/api/me", tags=["kundali"])


@fm_router.get("/family")
async def family_list(auth: dict = Depends(customer_dep), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(FamilyMember).where(
        FamilyMember.customer_id == auth["uid"]).order_by(FamilyMember.created_at))).scalars().all()
    return {"family": [{
        "id": f.id, "relationship": f.relationship, "name": f.name, "gender": f.gender,
        "dob": f.dob, "tob": f.tob, "birthPlace": f.birth_place, "city": f.city,
        "state": f.state, "country": f.country, "lat": f.lat, "lon": f.lon, "tz": f.tz,
        "gotra": f.gotra, "notes": f.notes, "createdAt": f.created_at,
    } for f in rows]}


@fm_router.post("/family", status_code=201)
async def family_add(body: dict, auth: dict = Depends(customer_dep),
                     db: AsyncSession = Depends(get_db)):
    b = body or {}
    rel = v_one_of(b.get("relationship") or b.get("rel") or "Other", RELATIONSHIPS, "Relationship")
    name = v_str(b.get("name") or b.get("n"), "Name", max_len=80)
    count = (await db.execute(select(func.count()).select_from(FamilyMember).where(
        FamilyMember.customer_id == auth["uid"]))).scalar_one()
    if int(count) >= 20:
        raise bad("You can save up to 20 family members")
    fid = "fm" + rid(5)
    db.add(FamilyMember(
        id=fid, customer_id=auth["uid"], relationship=rel, name=name,
        gender=(v_one_of(b.get("gender"), ["male", "female", "other"], "Gender") if b.get("gender") else ""),
        dob=(v_date(b.get("dob"), "Date of birth") if b.get("dob") else ""),
        tob=(v_str(b.get("tob"), "Time of birth", max_len=8) if b.get("tob") else ""),
        birth_place=(v_str(b.get("birthPlace"), "Birth place", optional=True, max_len=120) if b.get("birthPlace") else ""),
        city=(v_str(b.get("city"), "City", optional=True, max_len=80) if b.get("city") else ""),
        state=(v_str(b.get("state"), "State", optional=True, max_len=80) if b.get("state") else ""),
        country=(v_str(b.get("country"), "Country", optional=True, max_len=80) if b.get("country") else ""),
        lat=_finite(b.get("lat")), lon=_finite(b.get("lon")),
        tz=(v_str(b.get("tz"), "Time zone", optional=True, max_len=40) if b.get("tz") else ""),
        gotra=(v_str(b.get("gotra") or b.get("g"), "Gotra", optional=True, max_len=40) if (b.get("gotra") or b.get("g")) else ""),
        notes=(v_str(b.get("notes"), "Notes", optional=True, max_len=400) if b.get("notes") else ""),
        created_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
    ))
    await db.flush()
    return {"ok": True, "id": fid}


@fm_router.patch("/family/{fid}")
async def family_update(fid: str, body: dict, auth: dict = Depends(customer_dep),
                        db: AsyncSession = Depends(get_db)):
    f = (await db.execute(select(FamilyMember).where(
        FamilyMember.id == fid, FamilyMember.customer_id == auth["uid"]))).scalar_one_or_none()
    if not f:
        raise http_error(404, "Family member not found")
    b = body or {}
    if b.get("relationship") is not None or b.get("rel") is not None:
        f.relationship = v_one_of(b.get("relationship") or b.get("rel"), RELATIONSHIPS, "Relationship")
    if b.get("name") is not None or b.get("n") is not None:
        f.name = v_str(b.get("name") or b.get("n"), "Name", max_len=80)
    if b.get("gender") is not None:
        f.gender = v_one_of(b.get("gender"), ["male", "female", "other"], "Gender") if b.get("gender") else ""
    if b.get("dob") is not None:
        f.dob = v_date(b.get("dob"), "Date of birth") if b.get("dob") else ""
    if b.get("tob") is not None:
        f.tob = v_str(b.get("tob"), "Time of birth", max_len=8) if b.get("tob") else ""
    if b.get("birthPlace") is not None:
        f.birth_place = v_str(b.get("birthPlace"), "Birth place", optional=True, max_len=120)
    if b.get("city") is not None:
        f.city = v_str(b.get("city"), "City", optional=True, max_len=80)
    if b.get("state") is not None:
        f.state = v_str(b.get("state"), "State", optional=True, max_len=80)
    if b.get("country") is not None:
        f.country = v_str(b.get("country"), "Country", optional=True, max_len=80)
    if b.get("lat") is not None:
        f.lat = _finite(b.get("lat"))
    if b.get("lon") is not None:
        f.lon = _finite(b.get("lon"))
    if b.get("tz") is not None:
        f.tz = v_str(b.get("tz"), "Time zone", optional=True, max_len=40)
    if b.get("gotra") is not None or b.get("g") is not None:
        f.gotra = v_str(b.get("gotra") or b.get("g") or "", "Gotra", optional=True, max_len=40)
    if b.get("notes") is not None:
        f.notes = v_str(b.get("notes"), "Notes", optional=True, max_len=400)
    f.updated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    await db.flush()
    return {"ok": True}


@fm_router.delete("/family/{fid}")
async def family_delete(fid: str, auth: dict = Depends(customer_dep),
                        db: AsyncSession = Depends(get_db)):
    if not re.fullmatch(r"fm[a-z0-9]+", fid):
        raise http_error(404, "Family member not found")
    f = (await db.execute(select(FamilyMember).where(
        FamilyMember.id == fid, FamilyMember.customer_id == auth["uid"]))).scalar_one_or_none()
    if not f:
        raise http_error(404, "Family member not found")
    await db.delete(f)
    await db.flush()
    return {"ok": True}
