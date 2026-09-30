"""FastAPI application — mounts the auth + media routers and serves the same
static SPA + /media layout as the Node server, so the frontend swap is a
Render service switch, not a code change."""
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .routers import admin as admin_router
from .routers import auth as auth_router
from .routers import customer as customer_router
from .routers import kundali as kundali_router
from .routers import media as media_router
from .routers import pandit as pandit_router
from .routers import payments as payments_router
from .routers import reports_admin as reports_admin_router
from .security import AuthError, current_auth
from .db import get_db

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Boot bootstrap (Node seed.js parity): create tables if missing, then run
    the idempotent demo seeder. Safe on every restart."""
    from .db import Base, SessionLocal, engine
    from .seed_catalog import seed_catalog
    from .seed_demo import seed_demo
    from .seed_kundali import seed_kundali
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with SessionLocal() as db:
        await seed_catalog(db)
        await seed_demo(db)
        await seed_kundali(db)
        await db.commit()
    # Background jobs (Node parity: server/index.js arms startSweeper at boot).
    from .services.scheduler import start_digest_sweeper, start_no_show_sweeper, start_sweeper, stop_sweeper
    start_sweeper()  # KYC expiry sweep on a schedule (KYC_SWEEP_MS, default 6h; 0 disables)
    start_no_show_sweeper()  # Phase 16 no-show sweep (NOSHOW_SWEEP_MS, default 1h; 0 disables)
    start_digest_sweeper()  # Daily reopen-digest sweep (DIGEST_SWEEP_MS, default 24h; 0 disables)
    # Tick once at boot: an existing backlog is reported on the first boot after
    # this ships; restarts stay silent unless the state changed (snapshot diff).
    from .services.scheduler import digest_sweep_tick
    try:
        await digest_sweep_tick()
    except Exception:
        pass
    # Per-pandit flagging follow-up: release holds whose flag cleared (Node boot sweep parity).
    from .services.review_hold import sweep as hold_sweep
    from .db import SessionLocal as _SL
    async with _SL() as _db:
        await hold_sweep(_db)
        await _db.commit()
    try:
        yield
    finally:
        stop_sweeper()


app = FastAPI(title="DaivikPooja API (FastAPI)", version="1.0.0",
              docs_url="/api/docs", openapi_url="/api/openapi.json", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],           # tighten per environment when deploying
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(AuthError)
async def auth_error_handler(_req: Request, exc: AuthError):
    return JSONResponse(status_code=exc.status, content={"detail": exc.message})


@app.middleware("http")
async def media_cache_headers(request: Request, call_next):
    """30-day immutable caching for /media — Node parity."""
    resp = await call_next(request)
    if request.url.path.startswith("/media/"):
        resp.headers.setdefault("Cache-Control", "public, max-age=2592000, immutable")
    return resp


@app.get("/api/health")
async def health():
    return {"ok": True, "service": "daivikpooja-api-python", "ts": int(time.time() * 1000)}


@app.get("/api/state")
async def state(auth: dict | None = Depends(current_auth), db: AsyncSession = Depends(get_db)):
    """Role-scoped state object — the SPA's single data source (Node parity)."""
    from .state import build_state
    return await build_state(db, auth)


@app.post("/api/quote")
async def quote(body: dict, auth: dict | None = Depends(current_auth),
                db: AsyncSession = Depends(get_db)):
    """Public quote endpoint; coupons validated non-strictly (Node parity)."""
    from .models import User
    from .services.bookings import price_request
    user = None
    if auth and auth.get("role") == "customer":
        user = await db.get(User, auth["uid"])
    r = await price_request(db, user, body or {}, strict_coupon=False)
    return {"q": r["q"], "couponError": r["coupon_error"], "coupon": r["coupon"]}


@app.post("/api/leads", status_code=201)
async def capture_lead(body: dict, request: Request, db: AsyncSession = Depends(get_db)):
    """Public lead capture (Node /api/leads parity): the four enquiry forms;
    contact fields validated when present; audited with actor_role 'public'."""
    from .services.leads import capture
    return {"ok": True, "lead": await capture(db, body or {}, None,
                                              request.client.host if request.client else "")}


# Routers. The Razorpay webhook lives in payments_router and reads the RAW body
# for HMAC verification before any JSON parsing — same ordering rule as Node.
app.include_router(payments_router.router)
app.include_router(auth_router.router, prefix="/api")
app.include_router(media_router.router)
app.include_router(customer_router.router)
app.include_router(pandit_router.router)
app.include_router(admin_router.router)
app.include_router(kundali_router.router)
app.include_router(kundali_router.fm_router)
app.include_router(reports_admin_router.router)

# Static mounts, ORDER MATTERS: /media before the SPA catch-all at "/".
MEDIA = Path(settings.upload_dir) / "media"
MEDIA.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=MEDIA), name="media")
PUB = Path(__file__).resolve().parent.parent.parent / "public"
if PUB.exists():
    app.mount("/", StaticFiles(directory=PUB, html=True), name="spa")
