# DaivikPooja — Python Backend (FastAPI)

Restructure of the Node/Express backend to **Python + FastAPI**, targeting
**Supabase PostgreSQL** on **Render**, tested with **pytest** (Playwright E2E
comes with the frontend-parity milestone). The vanilla-JS SPA is served
unchanged — the API contract (routes, payloads, status codes) matches the Node
server so the cutover is a Render service switch, not a frontend rewrite.

## Status — vertical slice (security-critical core is live)

| Ported | Parity notes |
|---|---|
| JWT auth (email / admin / demo / change-password) | same claims `{uid, role, pid}`, 48h tokens, bcrypt hashes are **compatible with Node-era rows** |
| Lockout + login accounting | 5 fails → 15 min lock; `login_activity` rows; counters survive error responses (Node parity) |
| Account status gate | suspended/disabled rejected on every request, DB re-checked per call |
| Media engine (upload → review → publish) | pandit uploads forced `PENDING_ADMIN_REVIEW` for own bookings only; alt text required; magic-byte sniffing rejects fake `.jpg` (HTML/script) |
| Public gallery | `APPROVED + is_published` only, primary-first, `limit/offset/nextOffset` + category filter identical |
| Moderation + bulk | approve/reject(+reason)/publish/unpublish/primary, `POST /admin/media/bulk` with per-id results |
| WebP variants | Pillow port of `mediaVariants.js` (`.webp` q82, thumb `.t320.webp` q80), idempotent |
| **4-artifact delete** | original + thumb + webp + thumb_webp all removed, with stale-column fallback (port of Node fix `965ce74`) |
| Secure download | role-checked; anonymous/customer get private photos as 404 — "not listed" is not enough |
| Path safety | all file access passes through basename(); traversal-proof |

Not ported yet: bookings/pricing, payments (Razorpay), kundali engine,
OTP/SMS notify, Excel reports, admin catalogue management, full 16-puja +
18-photo seeder. The Node server keeps running until these land.

## Quickstart (local, SQLite — no config needed)

```bash
cd backend-python
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt        # Windows
.venv\Scripts\python -m pytest -q                    # 21 tests, green
.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000/api/docs for OpenAPI docs, or http://localhost:8000/
for the SPA. Boot auto-creates tables and runs the idempotent demo seeder
(admin `admin@daivikpuja.in` / `admin123`, customer/pandit demo logins).

## Switching to Supabase PostgreSQL

1. Create a project at supabase.com → *Project Settings → Database → Connection
   string → URI* (use the **pooler** URI, port 6543).
2. In `backend-python/.env` (copy from `.env.example`):

   ```
   DATABASE_URL=postgresql+asyncpg://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres
   JWT_SECRET=<python -c "import secrets; print(secrets.token_urlsafe(48))">
   DEMO_MODE=false
   ```

3. Apply schema with Alembic (recommended for managed Postgres):

   ```bash
   .venv/Scripts/python -m alembic revision --autogenerate -m "init schema"
   .venv/Scripts/python -m alembic upgrade head
   ```

   (For a dev database, simply booting the app also creates the schema.)

No code changes — the same models run on both engines.

## Layout

```
backend-python/
  app/
    config.py            settings from env (same names as Node's)
    db.py                async engine (SQLite ↔ Postgres via DATABASE_URL)
    models.py            users, pandits, pujas, bookings, puja_media, audit...
    security.py          JWT sign/verify + role dependencies
    util.py              validators, magic-byte sniffing, artifact naming
    services/
      auth_helpers.py    lockout, login activity, reset tokens
      media.py           the media engine (gallery/moderation/variants/delete)
    routers/
      auth.py, media.py  /api/auth/*, /api/admin/media, /api/pandit/media, ...
    seed_demo.py         bootstrap seeder (idempotent)
  migrations/            Alembic environment
  tests/                 21 parity tests (pytest + httpx ASGI)
```

## Render deployment (when the cutover is chosen)

- **Build:** `pip install -r backend-python/requirements.txt`
- **Start:** `uvicorn app.main:app --host 0.0.0.0 --port $PORT` (working dir `backend-python`)
- Set env vars: `DATABASE_URL`, `JWT_SECRET`, `ENVIRONMENT=production`, `DEMO_MODE=false`
- Health check path: `/api/health`

## Testing

```bash
.venv/Scripts/python -m pytest -q        # unit/API parity (SQLite, tmp dirs)
```

The suite includes the delete-completeness regression (upload case + seeded
4-artifact case), fake-JPEG rejection, ownership checks, lockout, and the
moderation state machine.
