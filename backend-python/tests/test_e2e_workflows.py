"""End-to-end workflow twin of tests/e2e-workflows.test.js — the MASTER-AUDIT
§33–37 item "E2E workflows to script-test: onboarding, booking (with
availability), customized puja, KYC, agreement, payout".

Where the Node suite walks all six journeys, this file scripts the five the
FastAPI twin actually serves. The sixth — the public Customized-Puja request
queue (POST /custom-puja -> admin queue -> convert) — has no Python route,
model or test anywhere in backend-python, and neither does the multipart pandit
registration (POST /pandit/register); both are recorded as open parity items in
MASTER-AUDIT rather than papered over with a test that asserts an absence.

Each test is a whole journey over the ASGI app: who acts, in what order, and
what must hold at every hop (slot contention, role gates, version locks,
audit trail) — unlike the per-domain suites, which probe one module each.

Run: pytest tests/test_e2e_workflows.py   (collected by `pytest -q` in CI)"""
import io

import pytest

pytestmark = pytest.mark.asyncio

JPEG = bytes([0xFF, 0xD8, 0xFF, 0xD9, 0x11, 0x22, 0x33, 0x44])


def h(token: str) -> dict:
    return {"Authorization": "Bearer " + token}


async def _admin(client) -> str:
    r = await client.post("/api/auth/admin",
                          json={"email": "admin@daivikpuja.in", "password": "admin123"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


async def _otp_customer(client, mobile: str, name: str) -> str:
    s = await client.post("/api/auth/otp/send", json={"mobile": mobile})
    assert s.status_code == 200, s.text
    v = await client.post("/api/auth/otp/verify",
                          json={"mobile": mobile, "otp": "123456", "name": name})
    assert v.status_code == 200, v.text
    assert v.json().get("token"), "a verified signup issues a session"
    return v.json()["token"]


def _day(n: int) -> str:
    import time
    return time.strftime("%Y-%m-%d", time.localtime(time.time() + n * 86400))


def _booking_body(day: int, slot: str = "10:00 AM") -> dict:
    return {"pujaId": "satyanarayan", "mode": "home", "date": _day(day), "slot": slot,
            "addr": {"line": "12 Test Street", "city": "Delhi NCR", "pin": "110001"},
            "panditId": "p1", "sam": [], "pra": []}


async def _audit(client, aa: str, action: str | None = None) -> list:
    entries = (await client.get("/api/admin/audit?limit=500", headers=h(aa))).json()["entries"]
    return [e for e in entries if not action or e.get("action") == action]


# ------------------------------------------------------------------ 1. onboarding
async def test_e2e_onboarding_guest_otp_becomes_a_visible_customer(client):
    aa = await _admin(client)
    mobile = "9811100911"

    token = await _otp_customer(client, mobile, "E2E Py Devotee")

    st = (await client.get("/api/state", headers=h(token))).json()
    assert st["me"]["n"] == "E2E Py Devotee", "the new customer is in their own state"
    assert st["me"]["m"] == mobile
    assert "dash" not in st, "customer-scoped payload never leaks the admin KPI block"

    # operations can see the signup too
    users = (await client.get("/api/state", headers=h(aa))).json()["users"]
    assert any(u.get("m") == mobile for u in users), "admin state lists the new account"

    # a wrong OTP yields no session
    await client.post("/api/auth/otp/send", json={"mobile": mobile})
    bad = await client.post("/api/auth/otp/verify", json={"mobile": mobile, "otp": "000000"})
    assert not bad.json().get("token"), "a wrong OTP issues no token"


# -------------------------------------------------- 2. booking with availability
async def test_e2e_booking_availability_contention_and_release(client):
    aa = await _admin(client)
    owner = await _otp_customer(client, "9811100912", "E2E Booked Devotee")
    day, slot = _day(70), "10:00 AM"

    # the customer only books pandits the availability endpoint offers
    avail = (await client.get(
        f"/api/pandits/available?date={day}&slot={slot.replace(' ', '%20')}&mode=home&city=Delhi%20NCR",
        headers=h(owner))).json()["pandits"]
    assert any(p["id"] == "p1" for p in avail), "p1 is available for that date+slot"

    created = await client.post("/api/bookings", json=_booking_body(70), headers=h(owner))
    assert created.status_code == 201, created.text
    bid = created.json()["booking"]["id"]

    # a DIFFERENT customer hitting the same pandit+slot is refused
    rival = await _otp_customer(client, "9811100913", "E2E Rival")
    clash = await client.post("/api/bookings", json=_booking_body(70), headers=h(rival))
    assert clash.status_code == 409, clash.text
    assert "Already booked in the " + slot + " slot on this date" in clash.json()["detail"], \
        "the conflict names the contested slot"

    # availability agrees the slot is gone
    after = (await client.get(
        f"/api/pandits/available?date={day}&slot={slot.replace(' ', '%20')}&mode=home&city=Delhi%20NCR",
        headers=h(rival))).json()["pandits"]
    assert not any(p["id"] == "p1" for p in after), "booked pandit leaves the list"

    # the rival cannot address someone else's booking
    assert (await client.post(f"/api/bookings/{bid}/cancel", headers=h(rival))).status_code == 404

    # the owner cancels and the slot returns to the pool
    cancel = await client.post(f"/api/bookings/{bid}/cancel", headers=h(owner))
    assert cancel.status_code == 200, cancel.text
    assert cancel.json()["booking"]["status"] == "Cancelled"

    freed = (await client.get(
        f"/api/pandits/available?date={day}&slot={slot.replace(' ', '%20')}&mode=home&city=Delhi%20NCR",
        headers=h(rival))).json()["pandits"]
    assert any(p["id"] == "p1" for p in freed), "slot released back to availability"
    assert (await client.post("/api/bookings", json=_booking_body(70), headers=h(rival))).status_code == 201


# ------------------------------------------------------------------------ 3. KYC
async def test_e2e_kyc_upload_review_verify_visible_and_audited(client):
    aa = await _admin(client)
    pt = (await client.post("/api/auth/demo", json={"role": "pandit"})).json()["token"]

    async def upload(doc_type: str, name: str) -> dict:
        r = await client.post("/api/pandit/kyc/documents",
                              files={"doc": (name, io.BytesIO(JPEG), "image/jpeg")},
                              data={"docType": doc_type}, headers=h(pt))
        assert r.status_code == 201, r.text
        return r.json()["document"]

    aad = await upload("AADHAAR", "aadhaar.jpg")
    assert aad["status"] == "PENDING"

    rev = await client.post(f"/api/admin/kyc/{aad['id']}/decide",
                            json={"status": "UNDER_REVIEW"}, headers=h(aa))
    assert rev.json()["document"]["status"] == "UNDER_REVIEW"
    ok = await client.post(f"/api/admin/kyc/{aad['id']}/decide",
                           json={"status": "VERIFIED", "expiresAt": 4102444800000}, headers=h(aa))
    assert ok.json()["document"]["status"] == "VERIFIED"
    assert ok.json()["document"]["expiresAt"], "expiry recorded"

    # a rejection is refused without a documented reason
    pan = await upload("PAN", "pan.jpg")
    no_reason = await client.post(f"/api/admin/kyc/{pan['id']}/decide",
                                  json={"status": "REJECTED"}, headers=h(aa))
    assert no_reason.status_code == 400, "rejection needs a reason"
    rej = await client.post(f"/api/admin/kyc/{pan['id']}/decide",
                            json={"status": "REJECTED", "reason": "Blurry photo"}, headers=h(aa))
    assert rej.json()["document"]["rejectReason"] == "Blurry photo"

    # the pandit sees both outcomes, reasons included
    mine = (await client.get("/api/pandit/kyc/documents", headers=h(pt))).json()["documents"]
    assert any(d["id"] == aad["id"] and d["status"] == "VERIFIED" for d in mine)
    assert any(d["status"] == "REJECTED" and d["rejectReason"] == "Blurry photo" for d in mine)

    # admin summary reflects the decisions
    summary = (await client.get("/api/admin/kyc", headers=h(aa))).json()
    assert any(d["id"] == aad["id"] and d["status"] == "VERIFIED" for d in summary["docs"])
    assert summary["counts"]["VERIFIED"] >= 1

    # the chain PENDING -> UNDER_REVIEW -> VERIFIED is audited old -> new
    log = await _audit(client, aa, "kyc.decide")
    assert any(e["detail"].get("from") == "PENDING" and e["detail"].get("to") == "UNDER_REVIEW"
               for e in log), "PENDING -> UNDER_REVIEW audited"
    assert any(e["detail"].get("from") == "UNDER_REVIEW" and e["detail"].get("to") == "VERIFIED"
               for e in log), "UNDER_REVIEW -> VERIFIED audited"
    assert any(e["detail"].get("reason") for e in log), "the rejection reason is recorded"

    # a customer never reaches the review desk
    ct = (await client.post("/api/auth/demo", json={"role": "customer"})).json()["token"]
    assert (await client.get("/api/admin/kyc", headers=h(ct))).status_code == 403


# ------------------------------------------------------------------ 4. agreement
async def test_e2e_agreement_publish_accept_registry_and_lock(client):
    import hashlib
    aa = await _admin(client)
    pt = (await client.post("/api/auth/demo", json={"role": "pandit"})).json()["token"]
    body = "Pandit partner agreement (E2E). The pandit commits to the code of conduct."

    draft = await client.post("/api/admin/agreements",
                              json={"title": "E2E partner agreement", "body": body}, headers=h(aa))
    assert draft.status_code == 201, draft.text
    aid = draft.json()["agreement"]["id"]
    assert draft.json()["agreement"]["status"] == "DRAFT"

    # invisible to pandits until published
    assert (await client.get("/api/pandit/agreement", headers=h(pt))).json()["current"] is None
    early = await client.post("/api/pandit/agreement/accept",
                              json={"agreementId": aid, "consent": True, "otp": "123456"},
                              headers=h(pt))
    assert early.status_code == 404, "an unpublished agreement cannot be accepted"

    pub = await client.post(f"/api/admin/agreements/{aid}/publish", json={}, headers=h(aa))
    assert pub.json()["agreement"]["status"] == "PUBLISHED"
    assert pub.json()["agreement"]["documentHash"] == hashlib.sha256(body.encode()).hexdigest(), \
        "document hash pinned to sha256(body)"
    assert (await client.post(f"/api/admin/agreements/{aid}/publish", json={}, headers=h(aa))).status_code == 409

    cur = (await client.get("/api/pandit/agreement", headers=h(pt))).json()["current"]
    assert cur["version"] == 1
    no_consent = await client.post("/api/pandit/agreement/accept",
                                   json={"agreementId": cur["id"], "consent": False, "otp": "123456"},
                                   headers=h(pt))
    assert no_consent.status_code == 400, "consent required"
    no_otp = await client.post("/api/pandit/agreement/accept",
                               json={"agreementId": cur["id"], "consent": True}, headers=h(pt))
    assert no_otp.status_code == 400, "OTP required"
    wrong = await client.post("/api/pandit/agreement/accept",
                              json={"agreementId": cur["id"], "consent": True, "otp": "000000"},
                              headers=h(pt))
    assert wrong.status_code == 400, "wrong OTP refused"

    await client.post("/api/auth/otp/send", json={"mobile": "9810000001"})  # p1's mobile
    acc = await client.post("/api/pandit/agreement/accept",
                            json={"agreementId": cur["id"], "consent": True, "otp": "123456"},
                            headers=h(pt))
    assert acc.status_code == 200, acc.text
    acceptance = acc.json()["acceptance"]
    assert acceptance["method"] == "DIGITAL" and acceptance["otpVerified"] is True
    assert acceptance.get("ip") and acceptance.get("device"), "IP + device captured"

    # version lock: the same version cannot be accepted twice
    await client.post("/api/auth/otp/send", json={"mobile": "9810000001"})
    dup = await client.post("/api/pandit/agreement/accept",
                            json={"agreementId": cur["id"], "consent": True, "otp": "123456"},
                            headers=h(pt))
    assert dup.status_code == 409, "duplicate acceptance refused"

    # registry + enriched audit carry exactly one acceptance
    reg = (await client.get(f"/api/admin/agreements/{cur['id']}/acceptances",
                            headers=h(aa))).json()["acceptances"]
    assert len(reg) == 1 and reg[0]["method"] == "DIGITAL"
    log = await _audit(client, aa, "agreement.accepted")
    assert len(log) == 1, "acceptance audited once"
    assert log[0]["ip"] == acceptance["ip"], "audit stores the IP the API returned"

    # an accepted version is locked against archiving; a pandit never reaches the desk
    assert (await client.post(f"/api/admin/agreements/{cur['id']}/archive",
                              json={}, headers=h(aa))).status_code == 409
    assert (await client.get("/api/admin/agreements", headers=h(pt))).status_code == 403


# --------------------------------------------------------------------- 5. payout
async def test_e2e_payout_book_pay_complete_process_disburse(client):
    aa = await _admin(client)
    ct = (await client.post("/api/auth/demo", json={"role": "customer"})).json()["token"]

    created = await client.post("/api/bookings", json=_booking_body(80, "06:00 PM"), headers=h(ct))
    assert created.status_code == 201, created.text
    bid = created.json()["booking"]["id"]

    pay = await client.post("/api/payments/verify", headers=h(ct), json={
        "bookingId": bid, "razorpay_order_id": "o_" + bid,
        "razorpay_payment_id": "p_" + bid, "razorpay_signature": "sig_" + bid})
    assert pay.status_code == 200, pay.text

    done = await client.post(f"/api/admin/bookings/{bid}/status",
                             json={"status": "Completed"}, headers=h(aa))
    assert done.status_code == 200, done.text

    # completion mints a PENDING payout with a money trail
    st = (await client.get("/api/state", headers=h(aa))).json()
    po = next((p for p in st["payouts"] if p["b"] == bid), None)
    assert po, "a payout row exists for the completed booking"
    assert po["st"] == "PENDING", "it starts pending"
    assert po["amt"] > 0 and po["gross"] >= po["amt"], "money trail present"
    assert po["comm"] == po["gross"] - po["amt"] + po["tax"] - po["adj"] + po["refd"], \
        "commission reconciles gross -> net"

    # finance moves it: pending -> processing -> disbursed
    assert (await client.post(f"/api/admin/payouts/{po['id']}/process",
                              json={}, headers=h(aa))).status_code == 200
    utr = "UTRPY" + str(po["id"])[-6:]
    disb = await client.post(f"/api/admin/payouts/{po['id']}/disburse",
                             json={"utr": utr}, headers=h(aa))
    assert disb.status_code == 200, disb.text
    assert disb.json()["payout"]["amt"] == po["amt"], "amount unchanged by the transition"

    # state agrees on both sides, with the UTR we handed over
    after = next(p for p in (await client.get("/api/state", headers=h(aa))).json()["payouts"]
                 if p["id"] == po["id"])
    assert after["st"] == "DISBURSED" and after["utr"] == utr, "UTR persisted"
    assert after["dd"], "disbursement date stamped"

    pt = (await client.post("/api/auth/demo", json={"role": "pandit"})).json()["token"]
    pst = (await client.get("/api/state", headers=h(pt))).json()["payouts"]
    assert any(p["id"] == po["id"] and p["st"] == "DISBURSED" for p in pst), \
        "the pandit sees their disbursed payout"

    log = await _audit(client, aa)
    assert any("payout" in (e.get("action") or "") for e in log), "payout transition audited"

    # DISBURSED is terminal
    again = await client.post(f"/api/admin/payouts/{po['id']}/disburse",
                              json={"utr": "UTR2"}, headers=h(aa))
    assert again.status_code >= 400, "a disbursed payout cannot be disbursed again"
