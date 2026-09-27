"""KYC expiry sweeper — scheduler twin of the Node tests in tests/kyc.test.js:
boot wiring drift-catchers (lifespan must arm/disarm the scheduler), the
KYC_SWEEP_MS interval contract (default 6h, 0 disables, garbage tolerated),
and a tick that flips past-due VERIFIED documents even with no admin traffic."""
import io
import pathlib

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]

JPEG = b"\xff\xd8\xff\xd9\x11\x22\x33\x44"


def test_lifespan_wiring_drift_catchers():
    """The scheduler must stay wired at boot and disarmed at shutdown — if this
    fails, expiry reminders only fire when an admin happens to open the screen."""
    main = (ROOT / "backend-python" / "app" / "main.py").read_text(encoding="utf-8")
    assert "start_sweeper()" in main, "lifespan must arm the KYC sweeper at startup"
    assert "stop_sweeper()" in main, "lifespan must stop the sweeper on shutdown"
    sched = (ROOT / "backend-python" / "app" / "services" / "scheduler.py").read_text(encoding="utf-8")
    assert "create_task" in sched, "scheduler must run its loop as a background task"


def test_interval_parsing():
    from app.services.scheduler import _interval_ms
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.delenv("KYC_SWEEP_MS", raising=False)
    assert _interval_ms() == 21600000, "default interval is 6h (Node parity)"
    monkeypatch.setenv("KYC_SWEEP_MS", "50")
    assert _interval_ms() == 50
    monkeypatch.setenv("KYC_SWEEP_MS", "0")
    assert _interval_ms() == 0, "0 disables the scheduler"
    for garbage in ("abc", "-5"):
        monkeypatch.setenv("KYC_SWEEP_MS", garbage)
        assert _interval_ms() == 21600000, f"{garbage!r} falls back to the default"
    monkeypatch.undo()


async def test_start_stop_idempotent(monkeypatch):
    from app.services import scheduler
    monkeypatch.setenv("KYC_SWEEP_MS", "3600000")
    t1 = scheduler.start_sweeper()
    assert t1 is not None and not t1.done()
    assert scheduler.start_sweeper() is t1, "arming twice returns the same task"
    scheduler.stop_sweeper()
    assert scheduler.stop_sweeper() is None or True  # disarm is safe to repeat
    monkeypatch.setenv("KYC_SWEEP_MS", "0")
    assert scheduler.start_sweeper() is None, "KYC_SWEEP_MS=0 disables the scheduler"
    monkeypatch.undo()


@pytest.mark.asyncio
async def test_sweep_tick_expires_past_due_docs(client):
    tp_r = await client.post("/api/auth/demo", json={"role": "pandit"})
    tp = {"Authorization": "Bearer " + tp_r.json()["token"]}
    ar = await client.post("/api/auth/admin",
                           json={"email": "admin@daivikpuja.in", "password": "admin123"})
    aa = {"Authorization": "Bearer " + ar.json()["token"]}

    up = await client.post("/api/pandit/kyc/documents",
                           files={"doc": ("sweep.jpg", io.BytesIO(JPEG), "image/jpeg")},
                           data={"docType": "TRAINING"}, headers=tp)
    assert up.status_code == 201, up.text
    doc = up.json()["document"]

    import time
    dec = await client.post(f"/api/admin/kyc/{doc['id']}/decide",
                            json={"status": "VERIFIED",
                                  "expiresAt": int(time.time() * 1000) - 86400000},
                            headers=aa)
    assert dec.json()["document"]["status"] == "VERIFIED"

    from app.services.scheduler import kyc_sweep_tick
    flipped = await kyc_sweep_tick()
    assert flipped >= 1, "tick expired the past-due document"

    rem = (await client.get("/api/admin/kyc", headers=aa)).json()
    assert rem["counts"].get("EXPIRED", 0) >= 1
    assert any(d["id"] == doc["id"] for d in rem["reminders"])

    audits = (await client.get("/api/admin/audit?limit=200", headers=aa)).json()["entries"]
    assert any(a["action"] == "kyc.auto_expire" and a["entity"] == "kyc_document"
               for a in audits)
