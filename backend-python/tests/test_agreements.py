"""Phases 23-25 — Python twin of tests/agreements.test.js: versioned publishing
with sha256 hashes, digital acceptance (OTP + IP + device into the enriched
audit log), the version lock (409 on repeat), archive protection and the manual
upload path."""
import hashlib
import io
import time

import pytest

pytestmark = pytest.mark.asyncio

PDF = b"%PDF-1.4\n%fake-signed-agreement\n"


def _admin_headers(client, token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _login(client, role: str) -> str:
    r = await client.post("/api/auth/demo", json={"role": role})
    assert r.status_code == 200, r.text
    return r.json()["token"]


async def _admin(client) -> str:
    r = await client.post("/api/auth/admin",
                          json={"email": "admin@daivikpuja.in", "password": "admin123"})
    return r.json()["token"]


async def test_agreements_versioning_acceptance_archive_upload(client):
    a = await _admin(client)
    tp = await _login(client, "pandit")
    aa = _admin_headers(client, a)
    pa = _admin_headers(client, tp)
    body1 = "Pandit partner agreement v1. The pandit commits to the code of conduct."

    # Draft v1 (empty text refused).
    d1 = await client.post("/api/admin/agreements", json={"title": "Pandit partner agreement", "body": body1}, headers=aa)
    assert d1.status_code == 201, d1.text
    assert d1.json()["agreement"]["version"] == 1
    assert d1.json()["agreement"]["status"] == "DRAFT"
    no_body = await client.post("/api/admin/agreements", json={"title": "x", "body": "  "}, headers=aa)
    assert no_body.status_code == 400

    # Before publication the pandit sees nothing and cannot accept a hidden draft.
    cur0 = await client.get("/api/pandit/agreement", headers=pa)
    assert cur0.json()["current"] is None
    early = await client.post("/api/pandit/agreement/accept",
                              json={"agreementId": d1.json()["agreement"]["id"], "consent": True, "otp": "123456"},
                              headers=pa)
    assert early.status_code == 404

    # Publish stamps sha256(body); double publish is 409.
    p1 = await client.post(f"/api/admin/agreements/{d1.json()['agreement']['id']}/publish", json={}, headers=aa)
    assert p1.status_code == 200, p1.text
    assert p1.json()["agreement"]["documentHash"] == hashlib.sha256(body1.encode()).hexdigest()
    rep = await client.post(f"/api/admin/agreements/{d1.json()['agreement']['id']}/publish", json={}, headers=aa)
    assert rep.status_code == 409

    # Consent + OTP are enforced; wrong OTP refused.
    cur = (await client.get("/api/pandit/agreement", headers=pa)).json()
    assert cur["current"]["version"] == 1
    no_consent = await client.post("/api/pandit/agreement/accept",
                                   json={"agreementId": cur["current"]["id"], "consent": False, "otp": "123456"}, headers=pa)
    assert no_consent.status_code == 400
    no_otp = await client.post("/api/pandit/agreement/accept",
                               json={"agreementId": cur["current"]["id"], "consent": True}, headers=pa)
    assert no_otp.status_code == 400
    wrong = await client.post("/api/pandit/agreement/accept",
                              json={"agreementId": cur["current"]["id"], "consent": True, "otp": "000000"}, headers=pa)
    assert wrong.status_code == 400

    # Demo OTP 123456 against the pandit's registered mobile accepts; IP/device captured.
    send = await client.post("/api/auth/otp/send", json={"mobile": "9810000001"})
    assert send.status_code == 200, send.text
    acc = await client.post("/api/pandit/agreement/accept",
                            json={"agreementId": cur["current"]["id"], "consent": True, "otp": "123456"}, headers=pa)
    assert acc.status_code == 200, acc.text
    assert acc.json()["acceptance"]["otpVerified"] is True
    assert acc.json()["acceptance"]["method"] == "DIGITAL"
    assert acc.json()["acceptance"]["ip"]
    assert acc.json()["acceptance"]["device"]

    # Version lock: a second acceptance of the same version is 409.
    await client.post("/api/auth/otp/send", json={"mobile": "9810000001"})
    dup = await client.post("/api/pandit/agreement/accept",
                            json={"agreementId": cur["current"]["id"], "consent": True, "otp": "123456"}, headers=pa)
    assert dup.status_code == 409

    # The enriched audit log carries the acceptance with IP + device.
    audits = (await client.get("/api/admin/audit?limit=500", headers=aa)).json()["entries"]
    accs = [x for x in audits if x["action"] == "agreement.accepted"]
    assert len(accs) == 1
    assert accs[0]["ip"] == acc.json()["acceptance"]["ip"]
    assert accs[0]["device"] == acc.json()["acceptance"]["device"]
    assert accs[0]["newValue"]["version"] == 1
    assert any(x["action"] == "agreement.published" and (x.get("newValue") or {}).get("hash") for x in audits)

    # An accepted version can never be archived.
    arch_refused = await client.post(f"/api/admin/agreements/{cur['current']['id']}/archive", json={}, headers=aa)
    assert arch_refused.status_code == 409

    # v2 becomes current; the v1 acceptance history remains visible.
    d2 = await client.post("/api/admin/agreements",
                           json={"title": "Pandit partner agreement", "body": "v2 text — revised commission schedule.",
                                 "effectiveFrom": "2026-10-01"}, headers=aa)
    assert d2.json()["agreement"]["version"] == 2
    p2 = await client.post(f"/api/admin/agreements/{d2.json()['agreement']['id']}/publish", json={}, headers=aa)
    assert p2.status_code == 200
    cur2 = (await client.get("/api/pandit/agreement", headers=pa)).json()
    assert cur2["current"]["version"] == 2
    assert len(cur2["myAcceptances"]) == 1
    assert cur2["myAcceptances"][0]["version"] == 1

    # Unaccepted PUBLISHED versions can be archived; archived cannot be re-published.
    arch2 = await client.post(f"/api/admin/agreements/{d2.json()['agreement']['id']}/archive",
                              json={"reason": "Typo in schedule"}, headers=aa)
    assert arch2.status_code == 200
    assert arch2.json()["agreement"]["status"] == "ARCHIVED"
    rep2 = await client.post(f"/api/admin/agreements/{d2.json()['agreement']['id']}/publish", json={}, headers=aa)
    assert rep2.status_code == 409

    # Manual upload path: a signed PDF becomes a published version with the file's hash.
    up = await client.post("/api/admin/agreements/file",
                           files={"doc": ("signed-v3.pdf", io.BytesIO(PDF), "application/pdf")},
                           data={"title": "Signed agreement (manual)"}, headers=aa)
    assert up.status_code == 201, up.text
    upj = up.json()
    assert upj["agreement"]["version"] == 3
    assert upj["agreement"]["status"] == "PUBLISHED"
    assert upj["agreement"]["documentHash"] == hashlib.sha256(PDF).hexdigest()
    assert upj["agreement"]["fileName"]

    # A non-PDF masquerading as one is refused.
    forgery = await client.post("/api/admin/agreements/file",
                                files={"doc": ("fake.pdf", io.BytesIO(b"not-a-pdf"), "application/pdf")},
                                data={"title": "x"}, headers=aa)
    assert forgery.status_code == 400

    # Pandits cannot reach the admin agreement surface.
    assert (await client.get("/api/admin/agreements", headers=pa)).status_code == 403
    assert (await client.post("/api/admin/agreements", json={"title": "x", "body": "y"}, headers=pa)).status_code == 403
    assert (await client.get(f"/api/admin/agreements/{upj['agreement']['id']}/acceptances", headers=pa)).status_code == 403

    # Admin acceptance registry for v1.
    acc1 = (await client.get(f"/api/admin/agreements/{cur['current']['id']}/acceptances", headers=aa)).json()["acceptances"]
    assert len(acc1) == 1
    assert acc1[0]["method"] == "DIGITAL"
    assert acc1[0]["panditName"]
