"""Phases 4 + 22 — Python twin of tests/kyc.test.js: per-document KYC and the
pandit account lifecycle (suspend blocks login + holds payouts, terminate is
final, reinstate restores)."""
import io
import time

import pytest

pytestmark = pytest.mark.asyncio

JPEG = b"\xff\xd8\xff\xd9\x11\x22\x33\x44"


def _day_plus(n: int) -> str:
    d = time.localtime(time.time() + n * 86400)
    return time.strftime("%Y-%m-%d", d)


async def _login(client, role: str) -> str:
    r = await client.post("/api/auth/demo", json={"role": role})
    assert r.status_code == 200, r.text
    return r.json()["token"]


async def _admin(client) -> str:
    r = await client.post("/api/auth/admin",
                          json={"email": "admin@daivikpuja.in", "password": "admin123"})
    return r.json()["token"]


async def _upload_doc(client, token: str, doc_type: str) -> dict:
    r = await client.post("/api/pandit/kyc/documents",
                          files={"doc": ("doc.jpg", io.BytesIO(JPEG), "image/jpeg")},
                          data={"docType": doc_type},
                          headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 201, r.text
    return r.json()["document"]


async def test_kyc_documents_lifecycle(client):
    tp = await _login(client, "pandit")
    admin = await _admin(client)
    pa = {"Authorization": f"Bearer {tp}"}
    aa = {"Authorization": f"Bearer {admin}"}

    doc = await _upload_doc(client, tp, "AADHAAR")
    assert doc["status"] == "PENDING"

    pan = await _upload_doc(client, tp, "PAN")

    # Reject without a reason is refused; with a reason the pandit sees it.
    no_reason = await client.post(f"/api/admin/kyc/{pan['id']}/decide",
                                  json={"status": "REJECTED"}, headers=aa)
    assert no_reason.status_code == 400
    rej = await client.post(f"/api/admin/kyc/{pan['id']}/decide",
                            json={"status": "REJECTED", "reason": "Blurry photo"}, headers=aa)
    assert rej.json()["document"]["rejectReason"] == "Blurry photo"

    # Explicit PENDING -> UNDER_REVIEW (Begin review); a reason is not required.
    b2r = await client.post(f"/api/admin/kyc/{doc['id']}/decide",
                            json={"status": "UNDER_REVIEW"}, headers=aa)
    assert b2r.json()["document"]["status"] == "UNDER_REVIEW"

    # Verify with expiry; the sweep then moves it to EXPIRED and reminders.
    dec = await client.post(f"/api/admin/kyc/{doc['id']}/decide",
                            json={"status": "VERIFIED", "expiresAt": int(time.time() * 1000) - 86400000},
                            headers=aa)
    assert dec.json()["document"]["status"] == "VERIFIED"
    rem = (await client.get("/api/admin/kyc", headers=aa)).json()
    assert rem["counts"].get("EXPIRED", 0) >= 1
    assert any(d["id"] == doc["id"] for d in rem["reminders"])

    # Re-upload request requires a reason; a fresh upload supersedes.
    rev = await client.post(f"/api/admin/kyc/{doc['id']}/decide",
                            json={"status": "REVERIFICATION_REQUIRED", "reason": "Name mismatch"},
                            headers=aa)
    assert rev.json()["document"]["status"] == "REVERIFICATION_REQUIRED"
    doc2 = await _upload_doc(client, tp, "AADHAAR")
    assert doc2["id"] != doc["id"], "a new row is created"

    # Pandit sees own documents with the rejection reason.
    mine = (await client.get("/api/pandit/kyc/documents", headers=pa)).json()["documents"]
    assert any(d["status"] == "REJECTED" and d["rejectReason"] == "Blurry photo" for d in mine)

    # Decisions audited with old -> new status and reason.
    audits = (await client.get("/api/admin/audit?limit=500", headers=aa)).json()["entries"]
    kyc_audits = [a for a in audits if a["entity"] == "kyc_document"]
    assert any(a["action"] == "kyc.decide" and a["detail"].get("reason") for a in kyc_audits)


async def test_account_lifecycle(client, db_session):
    admin = await _admin(client)
    tp = await _login(client, "pandit")  # p1
    aa = {"Authorization": f"Bearer {admin}"}

    # Suspension without a documented reason is refused.
    no_reason = await client.post("/api/admin/pandits/p1/lifecycle",
                                  json={"lifecycle": "SUSPENDED"}, headers=aa)
    assert no_reason.status_code == 400

    susp = await client.post("/api/admin/pandits/p1/lifecycle",
                             json={"lifecycle": "SUSPENDED", "reason": "Policy Violation",
                                   "to": "2030-01-01", "reviewDate": "2026-12-01"}, headers=aa)
    assert susp.json()["lifecycle"] == "SUSPENDED"

    # Existing token is revoked immediately (users.status re-checked per request).
    st = await client.get("/api/state", headers={"Authorization": f"Bearer {tp}"})
    assert st.status_code == 403 and "suspended" in st.json()["detail"].lower()

    # p2 round-trip: suspended pandit is not bookable; reinstatement restores it.
    ca = {"Authorization": "Bearer " + await _login(client, "customer")}
    body = {"pujaId": "rudra", "mode": "home", "date": _day_plus(95), "slot": "10:00 AM",
            "addr": {"line": "1 T", "city": "Chennai", "pin": "600005"},
            "panditId": "p2", "sam": [], "pra": []}
    susp2 = await client.post("/api/admin/pandits/p2/lifecycle",
                              json={"lifecycle": "SUSPENDED", "reason": "KYC Issue"}, headers=aa)
    assert susp2.json()["lifecycle"] == "SUSPENDED"
    blocked = await client.post("/api/bookings", headers=ca, json=body)
    assert blocked.status_code == 409 and "suspended" in blocked.json()["detail"].lower()

    rein = await client.post("/api/admin/pandits/p2/lifecycle",
                             json={"lifecycle": "ACTIVE"}, headers=aa)
    assert rein.json()["lifecycle"] == "ACTIVE"
    ok = await client.post("/api/bookings", headers=ca,
                           json={**body, "date": _day_plus(96)})
    assert ok.status_code in (200, 201), ok.text

    # Terminate is final.
    term = await client.post("/api/admin/pandits/p1/lifecycle",
                             json={"lifecycle": "TERMINATED", "reason": "Fraud Concern"}, headers=aa)
    assert term.json()["lifecycle"] == "TERMINATED"
    again = await client.post("/api/admin/pandits/p1/lifecycle",
                              json={"lifecycle": "ACTIVE"}, headers=aa)
    assert again.status_code == 409

    # Lifecycle transitions audited.
    audits = (await client.get("/api/admin/audit?limit=500", headers=aa)).json()["entries"]
    lc = [a for a in audits if a["action"] == "pandit.lifecycle"]
    assert any(a["detail"].get("to") == "SUSPENDED" and a["detail"].get("reason") for a in lc)
    assert any(a["detail"].get("to") == "TERMINATED" for a in lc)
