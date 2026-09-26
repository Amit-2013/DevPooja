"""Foundation tests: centralized payout engine + enriched audit log (Phases 7/8/31).
Node twin: tests/api.test.js 'payout engine: canonical lifecycle...'."""
import time

import pytest

pytestmark = pytest.mark.asyncio


def _day_plus(n: int) -> str:
    d = time.localtime(time.time() + n * 86400)
    return time.strftime("%Y-%m-%d", d)


async def _login_pandit(client):
    r = await client.post("/api/auth/demo", json={"role": "pandit"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


async def _login_admin(client):
    r = await client.post("/api/auth/admin", json={"email": "admin@daivikpuja.in",
                                                   "password": "admin123"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


async def _complete_booking(client, cust_token: str, pandit_token: str, day_offset: int = 50) -> str:
    """Create -> accept -> start -> complete a booking for pandit p1 (Node test flow)."""
    body = {"pujaId": "lakshmi", "mode": "home", "date": _day_plus(day_offset), "slot": "06:00 PM",
            "addr": {"line": "12 Test Street", "city": "Delhi NCR", "pin": "110001"},
            "panditId": "p1", "sam": [], "pra": []}
    r = await client.post("/api/bookings", json=body,
                          headers={"Authorization": f"Bearer {cust_token}"})
    assert r.status_code in (200, 201), r.text
    booking_id = r.json()["booking"]["id"]
    auth = {"Authorization": f"Bearer {pandit_token}"}
    a = await client.post(f"/api/pandit/bookings/{booking_id}/accept", json={}, headers=auth)
    assert a.status_code == 200, a.text
    s = await client.post(f"/api/pandit/bookings/{booking_id}/start", json={}, headers=auth)
    assert s.status_code == 200, s.text
    c = await client.post(f"/api/pandit/bookings/{booking_id}/complete", json={}, headers=auth)
    assert c.status_code == 200, c.text
    return booking_id


async def test_payout_engine_lifecycle(client):
    cust = (await client.post("/api/auth/demo", json={"role": "customer"})).json()["token"]
    token = await _login_pandit(client)
    admin = await _login_admin(client)

    booking_id = await _complete_booking(client, cust, token)
    booking2_id = await _complete_booking(client, cust, token, day_offset=51)

    st = (await client.get("/api/state", headers={"Authorization": f"Bearer {token}"})).json()
    mine = [b for b in st["bookings"] if b.get("panditId") == st["session"]["pid"]
            and b["status"] == "Completed"]
    assert {booking_id, booking2_id} <= {x["id"] for x in mine}, "bookings completed"

    po = next((p for p in st["payouts"] if p.get("b") == booking_id), None)
    assert po, "engine-created payout exists with its booking link"
    assert po["st"] == "PENDING"
    assert po["comm"] > 0 and po["gross"] == po["amt"] + po["comm"], "stored breakdown"

    detail = await client.get(f"/api/admin/payouts/{po['id']}",
                              headers={"Authorization": f"Bearer {admin}"})
    assert detail.status_code == 200
    assert detail.json()["payout"]["pd"] is None and detail.json()["payout"]["dd"] is None

    # Disbursement before processing is refused; process -> disburse stamps dates.
    early = await client.post(f"/api/admin/payouts/{po['id']}/disburse",
                              json={"paymentRef": "REF-1"},
                              headers={"Authorization": f"Bearer {admin}"})
    assert early.status_code == 409
    proc = await client.post(f"/api/admin/payouts/{po['id']}/process", json={},
                             headers={"Authorization": f"Bearer {admin}"})
    assert proc.json()["payout"]["st"] == "PROCESSING"
    assert proc.json()["payout"]["pd"]
    disb = await client.post(f"/api/admin/payouts/{po['id']}/disburse",
                             json={"paymentRef": "NEFT-88", "utr": "UTR123"},
                             headers={"Authorization": f"Bearer {admin}"})
    assert disb.json()["payout"]["st"] == "DISBURSED"
    assert disb.json()["payout"]["dd"]

    # Hold a fresh pending payout; the pandit sees the exact reason in /state.
    st2 = (await client.get("/api/state", headers={"Authorization": f"Bearer {token}"})).json()
    po2 = next((p for p in st2["payouts"] if p.get("b") == booking2_id), None)
    assert po2 and po2["st"] == "PENDING", "a second pending payout exists"

    # A hold without a reason is refused — pandits must see WHY.
    no_reason = await client.post(f"/api/admin/payouts/{po2['id']}/hold", json={},
                                  headers={"Authorization": f"Bearer {admin}"})
    assert no_reason.status_code == 400

    hold = await client.post(f"/api/admin/payouts/{po2['id']}/hold",
                             json={"reason": "Customer Dispute", "note": "Ticket TK1 under review"},
                             headers={"Authorization": f"Bearer {admin}"})
    assert hold.json()["payout"]["st"] == "ON_HOLD"
    assert hold.json()["payout"]["hr"] == "Customer Dispute"
    st3 = (await client.get("/api/state", headers={"Authorization": f"Bearer {token}"})).json()
    seen = next(p for p in st3["payouts"] if p["id"] == po2["id"])
    assert seen["hr"] == "Customer Dispute", "pandit sees WHY the payout is on hold"

    # Reversal of a disbursed payout with reason; adjustments blocked after disbursement.
    rev = await client.post(f"/api/admin/payouts/{po['id']}/reverse",
                            json={"reason": "Bank returned the transfer"},
                            headers={"Authorization": f"Bearer {admin}"})
    assert rev.json()["payout"]["st"] == "REVERSED"
    adj = await client.post(f"/api/admin/payouts/{po['id']}/adjustment", json={"amount": 100},
                            headers={"Authorization": f"Bearer {admin}"})
    assert adj.status_code == 409

    # Every transition was audited with old -> new status.
    audits = (await client.get("/api/admin/audit?limit=500",
                               headers={"Authorization": f"Bearer {admin}"})).json()["entries"]
    payouts_audits = [a for a in audits if a["entity"] == "payout"]
    assert len(payouts_audits) >= 4, "payout transitions audited"
    assert any(a["action"] == "payout.process" and a["detail"].get("from") == "PENDING"
               and a["detail"].get("to") == "PROCESSING" for a in payouts_audits)
    assert any(a["action"] == "payout.reverse" and a["detail"].get("reason")
               for a in payouts_audits)


async def test_audit_enrichment_and_payout_rules(client):
    admin = await _login_admin(client)
    auth = {"Authorization": f"Bearer {admin}"}

    # Commission change is audited with the previous value.
    r = await client.post("/api/admin/settings", json={"commission": 25}, headers=auth)
    assert r.status_code == 200
    audits = (await client.get("/api/admin/audit?limit=100", headers=auth)).json()["entries"]
    entry = next((a for a in audits if a["action"] == "settings.commission"), None)
    assert entry, "commission change audited"
    assert entry["detail"]["to"] == 25

    # Payout hold rules: read + update + validation.
    rules = await client.get("/api/admin/payout-rules", headers=auth)
    assert rules.status_code == 200 and isinstance(rules.json()["holds"], list) and rules.json()["holds"]
    bad_rule = await client.post("/api/admin/payout-rules",
                                 json={"holds": [{"reason": "X", "check": "nope"}]}, headers=auth)
    assert bad_rule.status_code == 400
    upd = await client.post("/api/admin/payout-rules",
                            json={"holds": [{"reason": "KYC Pending", "check": "pandit_kyc"}]},
                            headers=auth)
    assert upd.status_code == 200
    assert upd.json()["holds"][0]["check"] == "pandit_kyc"
