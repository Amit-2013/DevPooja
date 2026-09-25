"""FastAPI application — mounts the auth + media routers and serves the same
static SPA + /media layout as the Node server, so the frontend swap is a
Render service switch, not a code change."""
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .routers import auth as auth_router
from .routers import media as media_router
from .security import AuthError

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Boot bootstrap (Node seed.js parity): create tables if missing, then run
    the idempotent demo seeder. Safe on every restart."""
    from .db import Base, SessionLocal, engine
    from .seed_demo import seed_demo
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with SessionLocal() as db:
        await seed_demo(db)
        await db.commit()
    yield


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


# Routers (Razorpay webhook gets its own router with raw-body parsing before any
# JSON parsing — same ordering rule as the Node server — when payments are ported.)
app.include_router(auth_router.router, prefix="/api")
app.include_router(media_router.router)

# Static mounts, ORDER MATTERS: /media before the SPA catch-all at "/".
MEDIA = Path(settings.upload_dir) / "media"
MEDIA.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=MEDIA), name="media")
PUB = Path(__file__).resolve().parent.parent.parent / "public"
if PUB.exists():
    app.mount("/", StaticFiles(directory=PUB, html=True), name="spa")
