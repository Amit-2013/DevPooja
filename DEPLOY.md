# Hosting DaivikPooja

Two deliverables, two homes:

| Piece | What it is | Where it runs |
|---|---|---|
| **Backend + admin** | Express + SQLite API, also serves the whole site at `/` | Any host that runs Node (Render, Railway, Fly, VPS, your PC) |
| **Netlify site** | `dist/` — the live frontend, wired to your backend | Netlify (drag-and-drop or Git) |

You can also skip Netlify entirely: the backend alone serves the full website including the admin panel.

---

## Step 1 — Host the backend (it saves all data)

The backend persists everything in a single SQLite file (`data/daivikpooja.db`): users, bookings,
payments, kundalis, dosh analyses, recommendations. Verified working across restarts — a booking
created before a restart is still there after it.

### Option A — Render (free tier works)

1. Push this folder to a GitHub repo.
2. On https://render.com → **New → Web Service** → connect the repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Environment:** `Node 22` (or newer)
4. Add environment variables (Render → Environment):
   - `NODE_ENV` = `production`
   - `JWT_SECRET` = any long random string (`openssl rand -hex 32`)
   - `ADMIN_EMAIL` = your admin login email
   - `ADMIN_PASSWORD` = your admin login password
   - `DEMO_MODE` = `false` (real logins only; set `true` for demo logins + fixed OTP 123456)
   - `PAYMENT_MODE` = `mock` (marks payments paid; use `razorpay` with real keys later)
   - `CORS_ORIGIN` = your Netlify URL, e.g. `https://your-site.netlify.app` (add later if you use Netlify)
5. Deploy. Your API is now live at `https://your-name.onrender.com`.

> SQLite writes to the container disk. On Render's free tier the disk is ephemeral — data
> survives restarts but not redeploys. Attach a **Render Disk** (mount it and set
> `DB_PATH=/data/daivikpooja.db`) or use a paid plan to persist across redeploys.

### Option B — Railway / Fly.io / VPS

Same as above: `npm install`, `npm start`, set the env vars. On a VPS, run it behind nginx or
`systemd` and set `TRUST_PROXY=1` so rate limiting sees real client IPs.

### Option C — Your own PC for testing

```bash
npm install
npm start
# open http://localhost:3000
```

### Verify the backend is live

```bash
curl https://your-name.onrender.com/api/health
# {"ok":true}
```

---

## Step 2 — Put the frontend on Netlify

### Option A — drag-and-drop (no Git needed)

1. Open the `dist/` folder that came with this package (already built).
2. Open `dist/config.js` and put your backend URL between the quotes:
   ```js
   window.DP_API_BASE = "https://your-name.onrender.com";
   ```
3. Go to https://app.netlify.com/drop and drag the **`dist` folder** onto the page.
4. Done — the site is live on a `*.netlify.app` URL.

### Option B — rebuild yourself

```bash
npm install
node tools/build-netlify.js https://your-name.onrender.com
# or: set DP_API_BASE in .env and run `npm run build:netlify`
```
Then upload `dist/` (drag-and-drop) or connect the repo on Netlify with
**build command** `npm run build:netlify` and **publish directory** `dist`
(a `netlify.toml` with exactly that is included).

### Finish: allow the site to call the API

On the backend host, set:

```
CORS_ORIGIN=https://your-site.netlify.app
```

and redeploy/restart the backend. Without this, browsers block the site's requests to the API.

---

## Step 3 — Test it end to end

1. Open the Netlify site → **Kundali** → fill the form → generate (a real chart is computed).
2. Book any puja — the login modal takes any mobile number; in demo mode the OTP is `123456`.
3. Open `https://your-name.onrender.com` — the same site, same data, plus the admin panel
   (`#/admin`, login = `ADMIN_EMAIL` / `ADMIN_PASSWORD`).
4. Admin panel → **Kundali** tab: see the analysis created in step 1 and edit dosh→puja mappings.

**Data check (restart persistence):** restart the backend service from its dashboard, then reload
the site — the booking and kundali are still there.

---

## Environment variables (backend)

| Variable | Required | Meaning |
|---|---|---|
| `NODE_ENV` | production | enables production checks |
| `JWT_SECRET` | yes | signs login tokens — set a long random string |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | yes | admin panel login, created at boot |
| `DEMO_MODE` | no | `true`: sample data, demo logins, OTP `123456` |
| `PAYMENT_MODE` | no | `mock` (default) or `razorpay` |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | if razorpay | real payments |
| `CORS_ORIGIN` | if site ≠ API domain | comma-separated allowed origins, or `*` |
| `DB_PATH` | no | SQLite file path (default `./data/daivikpooja.db`) |
| `UPLOAD_DIR` | no | media uploads (default `./uploads`) |
| `TRUST_PROXY` | no | `1` behind nginx/Render/Railway |
| `TWILIO_*` / `SENDGRID_KEY` | no | real SMS/email; without them OTPs show only in demo mode |

Nothing is hard-coded per-host: the only deploy-specific value is `DP_API_BASE` inside
`dist/config.js` on the frontend, and `CORS_ORIGIN` on the backend.

---

## Where data lives

| What | Where |
|---|---|
| Everything structured | `data/daivikpooja.db` (SQLite, WAL mode) — users, bookings, payments, kundalis, dosh analyses, recommendations, catalogue |
| Pandit media uploads | `uploads/media/` |
| KYC documents | `uploads/kyc/` (never served publicly) |

Back up by copying `data/daivikpooja.db` (plus `uploads/` if you use media). Migrations apply
automatically at boot; `node server/migrate.js --status` shows what ran.
