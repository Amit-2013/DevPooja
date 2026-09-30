"""Background job scheduler — mirrors the Node sweeper contract
(services/kyc.js startSweeper/stopSweeper): one task per process, armed at app
startup (app.main lifespan). KYC_SWEEP_MS env tunes the KYC interval (default
6h); NOSHOW_SWEEP_MS tunes the cancellation no-show sweep (Phase 16, default
1h); 0 disables either. Runs the sweeps so reminders/no-shows fire even with no
admin traffic (the admin-read paths stay as the opportunistic catch-up). Tests
drive the tick() functions directly instead of waiting on the timers."""
import asyncio
import contextlib
import os

_swipe_task: asyncio.Task | None = None
_noshow_task: asyncio.Task | None = None
_digest_task: asyncio.Task | None = None


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


async def noshow_sweep_tick() -> int:
    """One Phase-16 no-show sweep pass over its own session."""
    from .cancellation import pandit_no_show_sweep
    from ..db import SessionLocal
    async with SessionLocal() as db:
        ids = await pandit_no_show_sweep(db, None)
        await db.commit()
        return len(ids)


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


def _noshow_interval_ms() -> int:
    raw = os.environ.get("NOSHOW_SWEEP_MS", "")
    try:
        n = int(raw)
    except ValueError:
        return 3600000  # 1h default (Node parity)
    return n if n > 0 else (0 if n == 0 else 3600000)


async def _noshow_loop(interval_ms: int) -> None:
    while True:
        await asyncio.sleep(interval_ms / 1000)
        try:
            await noshow_sweep_tick()
        except Exception as e:  # never let the background loop die
            print(f"[noshow.sweeper] {e}")


def start_no_show_sweeper() -> asyncio.Task | None:
    """Arm the Phase-16 no-show sweep (idempotent, same contract as the KYC sweep)."""
    global _noshow_task
    if _noshow_task and not _noshow_task.done():
        return _noshow_task
    ms = _noshow_interval_ms()
    if not ms:
        return None
    _noshow_task = asyncio.get_running_loop().create_task(_noshow_loop(ms))
    return _noshow_task


def _digest_interval_ms() -> int:
    raw = os.environ.get("DIGEST_SWEEP_MS", "")
    try:
        n = int(raw)
    except ValueError:
        return 86400000  # 24h default (Node parity)
    return n if n > 0 else (0 if n == 0 else 86400000)


async def digest_sweep_tick() -> int:
    """One scheduled reopen-digest pass over its own session (parity: Node digestSweep.tick)."""
    from .digest_sweep import tick
    from ..db import SessionLocal
    async with SessionLocal() as db:
        n = await tick(db)
        await db.commit()
        return n


async def _digest_loop(interval_ms: int) -> None:
    while True:
        await asyncio.sleep(interval_ms / 1000)
        try:
            await digest_sweep_tick()
        except Exception as e:  # never let the background loop die
            print(f"[digest.sweeper] {e}")


def start_digest_sweeper() -> asyncio.Task | None:
    """Arm the daily reopen-digest sweep (idempotent, same contract as the other sweeps)."""
    global _digest_task
    if _digest_task and not _digest_task.done():
        return _digest_task
    ms = _digest_interval_ms()
    if not ms:
        return None
    _digest_task = asyncio.get_running_loop().create_task(_digest_loop(ms))
    return _digest_task


def stop_sweeper() -> None:
    global _swipe_task, _noshow_task, _digest_task
    for task in (_swipe_task, _noshow_task, _digest_task):
        if task and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                pass
    _swipe_task = None
    _noshow_task = None
    _digest_task = None
