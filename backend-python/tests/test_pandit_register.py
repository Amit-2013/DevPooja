"""Python twin of tests/api.test.js 'pandit registration needs OTP and an ID
document; KYC approval' — the public multipart POST /api/pandit/register:

  * OTP is verified server-side (a wrong code or a missing document is 400,
    and because verify CONSUMES the code every retried attempt resends),
  * spec/langs are validated against the catalogue,
  * the duplicate mobile is refused,
  * the fresh pandit lands `pending` — not bookable — with the uploaded
    document attached to the profile and streamable to admins only,
  * activation stays gated behind the Phase-18 trial.

This closes the parity gap MASTER-AUDIT recorded for FastAPI registration."""
import io

import pytest

pytestmark = pytest.mark.asyncio

PDF = b"%PDF-1.4\n%fake-id-document\n"


async def _admin_headers(client) -> dict:
    r = await client.post("/api/auth/admin",
                          json={"email": "admin@daivikpuja.in", "password": "admin123"})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}


async def _send_otp(client, mobile: str) -> None:
    r = await client.post("/api/auth/otp/send", json={"mobile": mobile})
    assert r.status_code == 200, r.text


def _form(mobile: str, **over) -> dict:
    data = {"name": "Pt. Test", "mobile": mobile, "otp": "123456", "city": "Pune",
            "exp": "5", "langs": "Hindi", "spec": "ganesh,lakshmi"}
    data.update(over)
    return data


async def test_pandit_register_otp_id_document_and_pending_state(client):
    mobile = "9000044444"

    # no ID document -> refused (the OTP is consumed, so the retry resends)
    await _send_otp(client, mobile)
    no_doc = await client.post("/api/pandit/register", data=_form(mobile))
    assert no_doc.status_code == 400, no_doc.text
    assert "ID document" in no_doc.json()["detail"]

    # a wrong OTP never registers anyone
    await _send_otp(client, mobile)
    wrong_otp = await client.post("/api/pandit/register",
                                  data=_form(mobile, otp="000000"),
                                  files={"idDoc": ("id.pdf", io.BytesIO(PDF), "application/pdf")})
    assert wrong_otp.status_code == 400, wrong_otp.text

    # OTP + ID document -> registered
    await _send_otp(client, mobile)
    ok = await client.post("/api/pandit/register", data=_form(mobile),
                           files={"idDoc": ("id.pdf", io.BytesIO(PDF), "application/pdf")})
    assert ok.status_code == 201, ok.text
    assert ok.json() == {"ok": True}

    # operations sees a PENDING pandit whose uploaded doc is on the profile
    aa = await _admin_headers(client)
    st = (await client.get("/api/state", headers=aa)).json()
    np_ = next((p for p in st["pandits"] if p["n"] == "Pt. Test"), None)
    assert np_, "the new pandit exists in the admin state"
    assert np_["st"] == "pending", "a fresh registration is NOT bookable until reviewed"
    assert np_["kyc"] == ["idDoc"], "the uploaded document is attached to the profile"
    assert np_["city"] == "Pune" and np_["exp"] == 5

    # the document streams to admins...
    doc = await client.get(f"/api/admin/pandits/{np_['id']}/docs/idDoc", headers=aa)
    assert doc.status_code == 200, doc.text
    assert doc.content == PDF
    # ...and to nobody else
    ct = {"Authorization": "Bearer " + (await client.post("/api/auth/demo",
                                                          json={"role": "customer"})).json()["token"]}
    assert (await client.get(f"/api/admin/pandits/{np_['id']}/docs/idDoc",
                             headers=ct)).status_code == 403
    assert (await client.get(f"/api/admin/pandits/{np_['id']}/docs/nope",
                             headers=aa)).status_code == 404

    # the duplicate mobile is refused (fresh OTP, fresh attempt)
    await _send_otp(client, mobile)
    dup = await client.post("/api/pandit/register", data=_form(mobile),
                            files={"idDoc": ("id.pdf", io.BytesIO(PDF), "application/pdf")})
    assert dup.status_code == 409, dup.text
    assert "already registered" in dup.json()["detail"]

    # Phase 18 gate: KYC alone cannot activate — a trial must pass first
    gated = await client.post(f"/api/admin/pandits/{np_['id']}/kyc", headers=aa,
                              json={"status": "verified"})
    assert gated.status_code == 409, gated.text
    assert "No trial pooja has been assessed" in gated.json()["detail"]


async def test_pandit_register_validation(client):
    mobile = "9000044445"

    # a mobile that is not a valid Indian number never reaches the OTP
    bad_mobile = await client.post("/api/pandit/register", data=_form("12345"))
    assert bad_mobile.status_code == 400, bad_mobile.text

    # unknown specialisation / missing language are refused before insert
    await _send_otp(client, mobile)
    bad_spec = await client.post("/api/pandit/register", data=_form(mobile, spec="nope"),
                                 files={"idDoc": ("id.pdf", io.BytesIO(PDF), "application/pdf")})
    assert bad_spec.status_code == 400, bad_spec.text
    assert "puja" in bad_spec.json()["detail"]

    await _send_otp(client, mobile)
    no_lang = await client.post("/api/pandit/register", data=_form(mobile, langs=""),
                                files={"idDoc": ("id.pdf", io.BytesIO(PDF), "application/pdf")})
    assert no_lang.status_code == 400, no_lang.text
    assert "language" in no_lang.json()["detail"]

    # magic-byte check: a "PDF" that is not a PDF dies before the OTP is consumed
    await _send_otp(client, mobile)
    fake = await client.post("/api/pandit/register", data=_form(mobile),
                             files={"idDoc": ("id.pdf", io.BytesIO(b"<html>not a pdf</html>"),
                                              "application/pdf")})
    assert fake.status_code == 400, fake.text
    assert "does not match" in fake.json()["detail"]
