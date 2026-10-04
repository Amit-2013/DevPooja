"""Phase 19 — Python twin of tests/tickets.test.js: the complaints workflow.
One ticket state machine (app/services/tickets.py): role-driven replies that
move the status, explicit admin transitions with mandatory DECISION/RESOLVED
notes, RESOLVED closed for replies, pandit scope limited to their own bookings,
magic-checked evidence attachments filtered to /media/ urls, audits with
old->new, and legacy 'Open'/'Resolved' rows normalising through the serializer.
FastAPI errors surface as {"detail": ...} (parity with the Node {"error": ...})."""
import pytest
from sqlalchemy import select, update

from app.models import Booking, Pandit, Ticket, User
from tests.conftest import admin_login, login, otp_login

pytestmark = pytest.mark.asyncio

PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452") + b"\x00" * 24
MP4 = b"\x00\x00\x00\x20ftypisom" + b"\x00" * 24

ISSUE = "Pandit arrived 90 minutes late and the samagri packet was incomplete."


def _day_plus(n: int) -> str:
    import time
    return time.strftime("%Y-%m-%d", time.localtime(time.time() + n * 86400))


def _booking_body(o=None):
    o = o or {}
    import time
    return {"pujaId": "satyanarayan", "mode": "home",
            "date": time.strftime("%Y-%m-%d", time.localtime(time.time() + 20 * 86400)),
            "slot": "10:00 AM",
            "addr": {"line": "12 Test Street", "city": "Delhi NCR", "pin": "110001"},
            "panditId": "p1", "sam": [], "pra": [], **o}


async def _booking(client, tok, o=None):
    r = await client.post("/api/bookings", headers={"Authorization": "Bearer " + tok},
                          json=_booking_body(o))
    assert r.status_code == 201, r.text
    return r.json()["booking"]


async def _mk(client, tok, o=None):
    o = o or {}
    body = {"t": o.get("t", ISSUE)}
    if o.get("b"):
        body["b"] = o["b"]
    r = await client.post("/api/tickets", headers={"Authorization": "Bearer " + tok}, json=body)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _pandit_uid(db, pandit_id="p1"):
    return (await db.execute(select(Pandit.user_id).where(Pandit.id == pandit_id))).scalar_one()


async def test_customer_thread_create_detail_replies_while_open_owner_scope(client):
    ct = await login(client, "customer")
    other = await otp_login(client, "9810010001", "Second Devotee")
    ch = {"Authorization": "Bearer " + ct}
    oh = {"Authorization": "Bearer " + other}
    b = await _booking(client, ct, {"date": _day_plus(20)})
    tid = await _mk(client, ct, {"b": b["id"]})

    r = await client.get("/api/tickets/" + tid, headers=ch)
    assert r.status_code == 200, r.text
    t = r.json()["ticket"]
    assert t["st"] == "OPEN"
    assert t["b"] == b["id"]
    assert t["prio"] == "Medium"
    assert t["up"], "updated_at stamped"
    assert "UNDER_REVIEW" in t["next"], "the FE renders the legal transition set"
    assert "RESOLVED" in t["next"]
    assert r.json()["messages"] == []

    # a customer reply on OPEN just appends — triage has not started
    rep = await client.post(f"/api/tickets/{tid}/replies", headers=ch,
                            json={"message": "I have the UPI receipt and the arrival time recorded."})
    assert rep.status_code == 200, rep.text
    assert rep.json()["ticket"]["st"] == "OPEN", "customer reply on OPEN does not move the status"
    assert rep.json()["message"]["role"] == "customer"
    assert rep.json()["message"]["attachments"] == []
    after = await client.get("/api/tickets/" + tid, headers=ch)
    assert len(after.json()["messages"]) == 1

    # validation: empty and oversized messages are refused
    assert (await client.post(f"/api/tickets/{tid}/replies", headers=ch,
                              json={"message": ""})).status_code == 400
    assert (await client.post(f"/api/tickets/{tid}/replies", headers=ch,
                              json={"message": "x" * 1001})).status_code == 400
    assert (await client.post("/api/tickets", headers=ch, json={"t": ""})).status_code == 400
    assert (await client.post("/api/tickets", headers=ch,
                              json={"t": "x", "b": "TKNOPE99"})).status_code == 404, \
        "booking must be the caller's own"

    # another customer can neither read nor reply — 404, never a probe
    assert (await client.get("/api/tickets/" + tid, headers=oh)).status_code == 404
    assert (await client.post(f"/api/tickets/{tid}/replies", headers=oh,
                              json={"message": "sneaking in"})).status_code == 404
    assert (await client.get("/api/tickets/" + tid)).status_code == 401, "anon refused"


async def test_admin_transitions_notes_required_illegal_409_audits(client, db_session):
    ct = await login(client, "customer")
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    tid = await _mk(client, ct)

    assert (await client.get("/api/admin/tickets/" + tid, headers=aa)).status_code == 200
    assert (await client.post("/api/admin/tickets/TKNOPE9/transition", headers=aa,
                              json={"status": "UNDER_REVIEW"})).status_code == 404

    # matrix guards
    assert (await client.post(f"/api/admin/tickets/{tid}/transition", headers=aa,
                              json={"status": "DECISION"})).status_code == 409, \
        "OPEN -> DECISION is illegal"
    assert (await client.post(f"/api/admin/tickets/{tid}/transition", headers=aa,
                              json={"status": "OPEN"})).status_code == 409, "same status is a conflict"
    assert (await client.post(f"/api/admin/tickets/{tid}/transition", headers=aa,
                              json={"status": "WEIRD"})).status_code == 400
    assert (await client.post(f"/api/admin/tickets/{tid}/transition", headers=aa,
                              json={})).status_code == 400, "status required"

    # note rules
    assert (await client.post(f"/api/admin/tickets/{tid}/transition", headers=aa,
                              json={"status": "RESOLVED"})).status_code == 400, \
        "resolution required (legal target, no note)"

    ur = await client.post(f"/api/admin/tickets/{tid}/transition", headers=aa,
                           json={"status": "UNDER_REVIEW"})
    assert ur.status_code == 200, ur.text
    assert ur.json()["ticket"]["st"] == "UNDER_REVIEW"

    assert (await client.post(f"/api/admin/tickets/{tid}/transition", headers=aa,
                              json={"status": "DECISION"})).status_code == 400, \
        "decision note required"
    assert (await client.post(f"/api/admin/tickets/{tid}/transition", headers=aa,
                              json={"status": "RESOLVED"})).status_code == 400, "resolution required"

    dec = await client.post(f"/api/admin/tickets/{tid}/transition", headers=aa,
                            json={"status": "DECISION",
                                  "note": "Refund of 250 agreed; pandit briefed on the delay."})
    assert dec.status_code == 200, dec.text
    assert dec.json()["ticket"]["st"] == "DECISION"
    assert dec.json()["ticket"]["res"] == "Refund of 250 agreed; pandit briefed on the delay."
    thread = (await client.get("/api/admin/tickets/" + tid, headers=aa)).json()
    assert len(thread["messages"]) == 1, "the note also lands in the thread"
    assert thread["messages"][0]["role"] == "admin"
    assert thread["messages"][0]["message"] == "Refund of 250 agreed; pandit briefed on the delay."

    assert (await client.post(f"/api/admin/tickets/{tid}/transition", headers=aa,
                              json={"status": "RESOLVED"})).status_code == 400, \
        "DECISION -> RESOLVED still needs the resolution"
    done = await client.post(f"/api/admin/tickets/{tid}/transition", headers=aa,
                             json={"status": "RESOLVED",
                                   "note": "Refund issued against UPI reference R-77."})
    assert done.status_code == 200, done.text
    assert done.json()["ticket"]["st"] == "RESOLVED"
    assert done.json()["ticket"]["res"] == "Refund issued against UPI reference R-77."

    assert (await client.post(f"/api/admin/tickets/{tid}/transition", headers=aa,
                              json={"status": "PANDIT_RESPONSE"})).status_code == 409, \
        "RESOLVED only reopens through UNDER_REVIEW"
    reopen = await client.post(f"/api/admin/tickets/{tid}/transition", headers=aa,
                               json={"status": "UNDER_REVIEW",
                                     "note": "Customer disputed the refund amount."})
    assert reopen.status_code == 200, reopen.text
    assert reopen.json()["ticket"]["st"] == "UNDER_REVIEW"
    assert reopen.json()["ticket"]["res"] == "Refund issued against UPI reference R-77.", \
        "the resolution survives a reopen"

    # audits: every hop with old->new (feed is newest-first)
    audits = (await client.get("/api/admin/audit?limit=300", headers=aa)).json()["entries"]
    hops = [x for x in audits if x["action"] == "ticket.transitioned" and x["entityId"] == tid]
    assert len(hops) == 4, "OPEN->UNDER_REVIEW, ->DECISION, ->RESOLVED, ->UNDER_REVIEW"
    assert [(h["oldValue"], h["newValue"]) for h in hops] == [
        ("RESOLVED", "UNDER_REVIEW"), ("DECISION", "RESOLVED"),
        ("UNDER_REVIEW", "DECISION"), ("OPEN", "UNDER_REVIEW")]
    assert hops[0]["role"] == "admin"
    assert hops[1]["reason"] == "Refund issued against UPI reference R-77.", \
        "note recorded as the audit reason"
    assert hops[3]["detail"] == {"from": "OPEN", "to": "UNDER_REVIEW"}


async def test_replies_move_status_by_role_resolved_refuses_guidance(client, db_session):
    ct = await login(client, "customer")
    pt = await login(client, "pandit")
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    ch = {"Authorization": "Bearer " + ct}
    pth = {"Authorization": "Bearer " + pt}
    b = await _booking(client, ct, {"date": _day_plus(22)})
    tid = await _mk(client, ct, {"b": b["id"]})

    # pandit answers an OPEN ticket -> PANDIT_RESPONSE, audited as the pandit user
    p1 = await client.post(f"/api/pandit/tickets/{tid}/replies", headers=pth,
                           json={"message": "Reached by 11:40; traffic on the bypass was the cause."})
    assert p1.status_code == 200, p1.text
    assert p1.json()["ticket"]["st"] == "PANDIT_RESPONSE"
    p2 = await client.post(f"/api/pandit/tickets/{tid}/replies", headers=pth,
                           json={"message": "Adding: the customer had not kept the samagri ready either."})
    assert p2.json()["ticket"]["st"] == "PANDIT_RESPONSE", "follow-up keeps the status"
    c1 = await client.post(f"/api/tickets/{tid}/replies", headers=ch,
                           json={"message": "The delay started before the agreed slot, sharing my timeline."})
    assert c1.json()["ticket"]["st"] == "CUSTOMER_RESPONSE"
    a1 = await client.post(f"/api/admin/tickets/{tid}/replies", headers=aa,
                           json={"message": "Both sides heard; verifying the GPS log."})
    assert a1.json()["ticket"]["st"] == "CUSTOMER_RESPONSE", "admin note on a non-OPEN ticket stays"

    audits = (await client.get("/api/admin/audit?limit=300", headers=aa)).json()["entries"]
    replied = [x for x in audits if x["action"] == "ticket.replied" and x["entityId"] == tid]
    assert len(replied) == 4
    assert replied[2]["role"] == "pandit", "actor is the pandit user id — role from the users row"
    assert replied[2]["detail"]["status"] == "PANDIT_RESPONSE"
    assert replied[2]["detail"]["role"] == "pandit"
    assert replied[0]["detail"]["status"] == "CUSTOMER_RESPONSE"

    # DECISION locks the pandit out; the customer can still respond
    assert (await client.post(f"/api/admin/tickets/{tid}/transition", headers=aa,
                              json={"status": "PANDIT_RESPONSE"})).status_code == 200
    assert (await client.post(f"/api/admin/tickets/{tid}/transition", headers=aa,
                              json={"status": "DECISION",
                                    "note": "Compensation of 200 credited to the customer."})).status_code == 200
    locked = await client.post(f"/api/pandit/tickets/{tid}/replies", headers=pth,
                               json={"message": "But it was not our fault."})
    assert locked.status_code == 409, "the admin is recording a decision"
    assert "recording a decision" in locked.json()["detail"]
    cust = await client.post(f"/api/tickets/{tid}/replies", headers=ch,
                             json={"message": "Thanks — the credit has arrived."})
    assert cust.json()["ticket"]["st"] == "CUSTOMER_RESPONSE", "customer still answers during a decision"

    # admin reply on an OPEN ticket starts the review (second ticket)
    tid2 = await _mk(client, ct, {"t": "Duplicate complaint about the prasad delivery window.",
                                  "b": b["id"]})
    ar = await client.post(f"/api/admin/tickets/{tid2}/replies", headers=aa,
                           json={"message": "Picking this up for triage."})
    assert ar.json()["ticket"]["st"] == "UNDER_REVIEW"

    # /resolve compat alias: closes with its own note
    alias = await client.post(f"/api/admin/tickets/{tid2}/resolve", headers=aa)
    assert alias.status_code == 200, alias.text
    assert alias.json()["ok"] is True
    assert alias.json()["ticket"]["st"] == "RESOLVED"
    assert alias.json()["ticket"]["res"] == "Resolved by admin"

    # RESOLVED is closed for business — everyone is refused with guidance
    for tok, url in ((ct, f"/api/tickets/{tid2}/replies"),
                     (pt, f"/api/pandit/tickets/{tid2}/replies"),
                     (await admin_login(client), f"/api/admin/tickets/{tid2}/replies")):
        r = await client.post(url, headers={"Authorization": "Bearer " + tok},
                              json={"message": "One more thing…"})
        assert r.status_code == 409, url
        assert "Raise a new ticket" in r.json()["detail"]

    still = (await client.get("/api/admin/tickets/" + tid2, headers=aa)).json()
    assert still["messages"][-1]["message"] == "Resolved by admin", \
        "no refused reply reached the thread"


async def test_evidence_upload_filtering_and_attachment_cap(client):
    ct = await login(client, "customer")
    h = {"Authorization": "Bearer " + ct}

    r = await client.post("/api/tickets/evidence", headers=h,
                          files=[("evidence", ("one.png", PNG, "image/png")),
                                 ("evidence", ("clip.mp4", MP4, "video/mp4"))])
    assert r.status_code == 200, r.text
    urls = r.json()["urls"]
    assert len(urls) == 2
    assert all(u.startswith("/media/") for u in urls), "urls served from the media dir"
    assert ",".join(sorted(u.split(".")[-1] for u in urls)) == "mp4,png", \
        "extensions follow the sniffed real types"

    fake = await client.post("/api/tickets/evidence", headers=h,
                             files=[("evidence", ("fake.png", b"definitely not an image", "image/png"))])
    assert fake.status_code == 400, "magic check refuses mismatched content"
    anon = await client.post("/api/tickets/evidence",
                             files=[("evidence", ("x.png", PNG, "image/png"))])
    assert anon.status_code == 401, "signed-in roles only"

    tid = await _mk(client, ct)
    rep = await client.post(f"/api/tickets/{tid}/replies", headers=h,
                            json={"message": "Screenshots of the delay attached.",
                                  "attachments": urls + ["http://evil.example/payload.png",
                                                         "/etc/passwd"]})
    assert rep.status_code == 200, rep.text
    assert rep.json()["message"]["attachments"] == urls, "foreign strings dropped, order preserved"

    many = await client.post(f"/api/tickets/{tid}/replies", headers=h,
                             json={"message": "Nine files, only eight should stick.",
                                   "attachments": [f"/media/bulk{i}.png" for i in range(9)]})
    assert len(many.json()["message"]["attachments"]) == 8, "capped at 8 attachments"


async def test_pandit_scope_only_own_bookings(client):
    ct = await login(client, "customer")
    pt = await login(client, "pandit")
    cth = {"Authorization": "Bearer " + ct}
    pth = {"Authorization": "Bearer" + " " + pt}
    mine = await _booking(client, ct, {"date": _day_plus(24)})
    others = await _booking(client, ct, {"date": _day_plus(30), "panditId": "p2"})
    own = await _mk(client, ct, {"b": mine["id"]})
    foreign = await _mk(client, ct, {"b": others["id"]})
    homeless = await _mk(client, ct, {"t": "Payment settled but no booking was ever linked to this complaint."})

    listing = (await client.get("/api/pandit/tickets", headers=pth)).json()["tickets"]
    assert any(t["id"] == own for t in listing), "own booking ticket listed"
    assert not any(t["id"] == foreign for t in listing), "another pandit's booking never listed"
    assert not any(t["id"] == homeless for t in listing), "booking-less tickets are not the pandit's"

    assert (await client.get("/api/pandit/tickets/" + own, headers=pth)).status_code == 200
    assert (await client.get("/api/pandit/tickets/" + foreign, headers=pth)).status_code == 404
    assert (await client.get("/api/pandit/tickets/" + homeless, headers=pth)).status_code == 404
    assert (await client.post(f"/api/pandit/tickets/{foreign}/replies", headers=pth,
                              json={"message": "not mine"})).status_code == 404
    assert (await client.post(f"/api/pandit/tickets/{homeless}/replies", headers=pth,
                              json={"message": "not mine either"})).status_code == 404
    ok = await client.post(f"/api/pandit/tickets/{own}/replies", headers=pth,
                           json={"message": "On it — reaching out to the customer today."})
    assert ok.status_code == 200, ok.text
    assert ok.json()["ticket"]["st"] == "PANDIT_RESPONSE"

    assert (await client.get("/api/pandit/tickets", headers=cth)).status_code == 403, \
        "customers never enter the pandit portal"


async def test_access_admin_only_and_legacy_status_normalises(client, db_session):
    ct = await login(client, "customer")
    pt = await login(client, "pandit")
    aa = {"Authorization": "Bearer " + await admin_login(client)}
    tid = await _mk(client, ct)
    tid2 = await _mk(client, ct, {"t": "Complaint migrated from the pre-workflow backlog."})

    assert (await client.get("/api/admin/tickets/" + tid)).status_code == 401, "anon refused"
    assert (await client.get("/api/admin/tickets/" + tid,
                             headers={"Authorization": "Bearer " + ct})).status_code == 403, "customer refused"
    assert (await client.get("/api/admin/tickets/" + tid,
                             headers={"Authorization": "Bearer " + pt})).status_code == 403, "pandit refused"
    assert (await client.post(f"/api/admin/tickets/{tid}/transition",
                              headers={"Authorization": "Bearer " + ct},
                              json={"status": "RESOLVED", "note": "x"})).status_code == 403

    # pre-034 vocabulary normalises through norm() wherever it is read
    await db_session.execute(update(Ticket).where(Ticket.id == tid).values(status="Open"))
    await db_session.commit()
    legacy = (await client.get("/api/admin/tickets/" + tid, headers=aa)).json()
    assert legacy["ticket"]["st"] == "OPEN", "'Open' reads as OPEN"
    assert (await client.post(f"/api/admin/tickets/{tid}/transition", headers=aa,
                              json={"status": "UNDER_REVIEW"})).status_code == 200, \
        "the matrix works on legacy rows"
    view = (await client.get("/api/tickets/" + tid,
                             headers={"Authorization": "Bearer " + ct})).json()
    assert view["ticket"]["st"] == "UNDER_REVIEW"

    await db_session.execute(update(Ticket).where(Ticket.id == tid2).values(status="Resolved"))
    await db_session.commit()
    legacy2 = (await client.get("/api/admin/tickets/" + tid2, headers=aa)).json()
    assert legacy2["ticket"]["st"] == "RESOLVED", "'Resolved' reads as RESOLVED"
    assert (await client.post(f"/api/tickets/{tid2}/replies",
                              headers={"Authorization": "Bearer " + ct},
                              json={"message": "still broken"})).status_code == 409, \
        "legacy resolved tickets stay closed"
