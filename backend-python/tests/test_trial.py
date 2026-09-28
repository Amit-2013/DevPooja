"""Phase 18 — Python twin of tests/trial.test.js: the activation gate requires
a PASSED trial (all 7 dimensions scored, mean >= pass mark); FAILED and
REASSESSMENT_REQUIRED block activation; partial scoring is refused; every
write is audited."""
import pytest

from tests.conftest import admin_login, login

pytestmark = pytest.mark.asyncio

ALL7 = {"punctuality": 4, "communication": 4, "ritualCompliance": 4, "presentation": 4,
        "customerInteraction": 4, "digitalCapability": 4, "documentation": 4}


async def _reject(client, aa, pid):
    r = await client.post(f"/api/admin/pandits/{pid}/kyc", headers=aa,
                          json={"status": "rejected", "reason": "Phase 18 gate test"})
    assert r.status_code == 200, r.text


async def test_trial_lifecycle_and_gate(client):
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    await _reject(client, aa, "p6")

    # gate: no trial at all
    blocked = await client.post("/api/admin/pandits/p6/kyc", headers=aa, json={"status": "verified"})
    assert blocked.status_code == 409, blocked.text
    assert "No trial pooja has been assessed" in blocked.json()["detail"]

    s = await client.post("/api/admin/trials", headers=aa,
                          json={"panditId": "p6", "date": "2026-10-15", "service": "Satyanarayan Katha (home)"})
    assert s.status_code == 201, s.text
    assert s.json()["trial"]["result"] == "PENDING"
    assert (await client.post("/api/admin/trials", headers=aa,
                              json={"panditId": "p6", "date": "nope"})).status_code == 400
    assert (await client.post("/api/admin/trials", headers=aa,
                              json={"panditId": "p6", "date": "2026-10-15"})).status_code == 400, "service required"
    assert (await client.post("/api/admin/trials", headers=aa,
                              json={"panditId": "nope", "date": "2026-10-15", "service": "x"})).status_code == 404

    # gate: scheduled but not assessed
    blocked2 = await client.post("/api/admin/pandits/p6/kyc", headers=aa, json={"status": "verified"})
    assert blocked2.status_code == 409
    assert "has not been assessed yet" in blocked2.json()["detail"]

    # partial scoring refused (camelCase spelling must be accepted — parity with the SPA)
    partial = {k: v for k, v in ALL7.items() if k != "documentation"}
    pr = await client.post(f"/api/admin/trials/{s.json()['trial']['id']}/record", headers=aa,
                           json={"scores": partial})
    assert pr.status_code == 400
    assert "documentation" in pr.json()["detail"]
    bad_val = await client.post(f"/api/admin/trials/{s.json()['trial']['id']}/record", headers=aa,
                                json={"scores": {**ALL7, "punctuality": 9}})
    assert bad_val.status_code == 400, "1..5 enforced"

    # weak scores -> FAILED
    low = await client.post(f"/api/admin/trials/{s.json()['trial']['id']}/record", headers=aa,
                            json={"scores": {**ALL7, "punctuality": 2, "communication": 3,
                                             "presentation": 2, "customerInteraction": 3}})
    assert low.status_code == 200, low.text
    assert low.json()["trial"]["result"] == "FAILED", "mean < 3.5 fails"

    # gate: latest trial FAILED
    blocked3 = await client.post("/api/admin/pandits/p6/kyc", headers=aa, json={"status": "verified"})
    assert blocked3.status_code == 409
    assert "ended FAILED" in blocked3.json()["detail"]

    # new trial, strong scores -> PASSED -> gate opens
    s2 = await client.post("/api/admin/trials", headers=aa,
                           json={"panditId": "p6", "date": "2026-11-01", "service": "Ganesh Puja (home)"})
    rec = await client.post(f"/api/admin/trials/{s2.json()['trial']['id']}/record", headers=aa,
                            json={"scores": ALL7})
    assert rec.status_code == 200, rec.text
    assert rec.json()["trial"]["result"] == "PASSED"
    assert rec.json()["trial"]["finalScore"] == 4

    ok = await client.post("/api/admin/pandits/p6/kyc", headers=aa, json={"status": "verified"})
    assert ok.status_code == 200, "activation allowed after a PASSED trial"
    # already verified -> not gated (grandfathered transitions)
    again = await client.post("/api/admin/pandits/p6/kyc", headers=aa, json={"status": "verified"})
    assert again.status_code == 200

    audits = (await client.get("/api/admin/audit?limit=300", headers=aa)).json()["entries"]
    acts = {a["action"] for a in audits}
    assert "trial.scheduled" in acts and "trial.recorded" in acts
    trials = (await client.get("/api/admin/trials", params={"panditId": "p6"}, headers=aa)).json()["trials"]
    assert len(trials) == 2
    tok = await login(client, "customer")
    assert (await client.get("/api/admin/trials", headers={"Authorization": "Bearer " + tok})).status_code == 403
    ptok = await login(client, "pandit")
    mine = (await client.get("/api/pandit/me/trial", headers={"Authorization": "Bearer " + ptok})).json()["trials"]
    assert isinstance(mine, list), "pandit self-view works"


async def test_reassessment_requires_feedback_and_blocks(client):
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    await _reject(client, aa, "p3")
    s = await client.post("/api/admin/trials", headers=aa,
                          json={"panditId": "p3", "date": "2026-10-20", "service": "Rudrabhishek (temple)"})
    no_notes = await client.post(f"/api/admin/trials/{s.json()['trial']['id']}/record", headers=aa,
                                 json={"scores": ALL7, "forceResult": "REASSESSMENT_REQUIRED"})
    assert no_notes.status_code == 400, "reassessment requires written feedback"
    rec = await client.post(f"/api/admin/trials/{s.json()['trial']['id']}/record", headers=aa,
                            json={"scores": ALL7, "forceResult": "REASSESSMENT_REQUIRED",
                                  "notes": "Mantra pronunciation drifted on the Sankalp; reassess after coaching."})
    assert rec.status_code == 200, rec.text
    assert rec.json()["trial"]["result"] == "REASSESSMENT_REQUIRED"
    blocked = await client.post("/api/admin/pandits/p3/kyc", headers=aa, json={"status": "verified"})
    assert blocked.status_code == 409
    assert "ended REASSESSMENT_REQUIRED" in blocked.json()["detail"]
    s2 = await client.post("/api/admin/trials", headers=aa,
                           json={"panditId": "p3", "date": "2026-10-25", "service": "Retry"})
    bad_force = await client.post(f"/api/admin/trials/{s2.json()['trial']['id']}/record", headers=aa,
                                  json={"scores": ALL7, "forceResult": "PASSED"})
    assert bad_force.status_code == 400, "PASSED is computed, never forced"
