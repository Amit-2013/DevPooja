"""Background job scheduler — mirrors the Node sweeper contract
(services/kyc.js startSweeper/stopSweeper): one task per process, armed at app
startup (app.main lifespan). KYC_SWEEP_MS env tunes the interval (default 6h);
0 disables. Runs the KYC expiry sweep so reminders fire even with no admin
traffic (the admin-read path in services/kyc.py stays as the opportunistic
catch-up). Tests drive tick() directly instead of waiting on the timer."""
import asyncio
import contextlib
import os

_swipe_task: asyncio.Task | None = None


async def kyc_sweep_tick() -> int:
    """One scheduled sweep pass over its own session (parity: Node kyc.tick)."""
    from .kyc import sweep
    from ..db import SessionLocal
    async with SessionLocal() as db:
        n = await sweep(db)
        await db.commit()
        return n


async def _loop(interval_ms: int) -> None:
    while True:
        await asyncio.sleep(interval_ms / 1000)
        try:
            await kyc_sweep_tick()
        except Exception as e:  # never let the background loop die
            print(f"[kyc.sweeper] {e}")


def _interval_ms() -> int:
    raw = os.environ.get("KYC_SWEEP_MS", "")
    try:
        n = int(raw)
    except ValueError:
        return 21600000  # 6h default (Node parity)
    return n if n > 0 else (0 if n == 0 else 21600000)


def start_sweeper() -> asyncio.Task | None:
    """Arm the scheduled sweep (idempotent). Returns the task, or None if disabled."""
    global _swipe_task
    if _swipe_task and not _swipe_task.done():
        return _swipe_task
    ms = _interval_ms()
    if not ms:
        return None
    _swipe_task = asyncio.get_running_loop().create_task(_loop(ms))
    return _swipe_task


def stop_sweeper() -> None:
    global _swipe_task
    if _swipe_task and not _swipe_task.done():
        _swipe_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            pass
    _swipe_task = None
