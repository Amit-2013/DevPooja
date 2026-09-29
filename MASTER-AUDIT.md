# DaivikPooja — Master Technical Audit (Phases 0–2)

Authoritative feature/status map produced before any Phase 3+ implementation, per the
master prompt's AUDIT → MAP → DEDUPLICATE rule. Statuses:
`WORKING` (exists, tested, in use) · `PARTIAL` (exists, incomplete) · `BUGGY` ·
`DUPLICATED` · `MISSING` (not implemented anywhere).

Verification baseline at audit time: Node 67/67 (30 API + 4 security + 2 KYC/lifecycle + 1 agreements + 1 KYC sweeper + 2 QA/profile + 7 ledger/tiers + 4 cancellation + 2 trial + 6 incident + 3 media date-gate + 2 temple + 3 pricing),
Python 132/132 (incl. CI-wiring guards + audit-claim guards + foundation + availability +
security + KYC/lifecycle + agreements + ledger + cancellation + trial + incident + media date-gate + temple + pricing suites), UI smoke clean. `backend-python/tests/test_audit_claims.py`
pins the inventory claims in this document to the real codebase so the two cannot
silently drift apart.

Legend — **N** = Node/Express (`server/`), **P** = FastAPI port (`backend-python/`,
Node-parity contract), **FE** = `public/js/` SPA, **DB** = SQLite schema.

---

## 0. Inventory snapshot (refreshed after the foundation/availability/security rounds)

| Layer | Count | Notes |
|---|---|---|
| N endpoints | 115 | admin 71, customer 16, pandit 13, kundali 9, auth 6 |
| P endpoints | 73 | admin 22, media 11, customer 12, pandit 9, kundali 9, auth 7, reports 2, payments 1 |
| N tables | ~58 | `server/db.js` + migrations 001–020 (012 audit/payout, 013 availability, 014 scaffolding, 015 account lifecycle, 016 profile+QA, 017 photo date gate, 018 incident reopen, 019 temple management, 020 puja mode pricing) |
| P models | 48 | `app/models.py`, mirrored incl. kundali set + 014 scaffolding + qa_records (016) |
| FE | 8 JS files, ~1111 LOC + `account.js` | hash router in `main.js`; portals in `portal-admin.js` |
| Reports | 30 ids | 28 + `payout-audit` + `dakshina` + `transactions`; REPORTS registry + openpyxl twin (`reports.py`, `xlsx.py`) |
| Tests | Node 67 (30 API + 4 security + 2 KYC/lifecycle + 1 agreements + 1 KYC sweeper + 2 QA/profile + 7 ledger/tiers + 4 cancellation + 2 trial + 6 incident + 3 media date-gate + 2 temple + 3 pricing), Python 132 | `tests/api.test.js`, `tests/security.test.js`, `tests/kyc.test.js`, `tests/agreements.test.js`, `tests/qa.test.js`, `tests/ledger.test.js`, `tests/cancellation.test.js`, `tests/trial.test.js`, `tests/incident.test.js`, `tests/mediagate.test.js`, `tests/temple.test.js`, `tests/pricing.test.js`, `backend-python/tests/` |

**Standing Python-parity gaps** (recorded pre-audit, re-confirmed): admin puja editing,
pandit registration/KYC uploads, campaigns/leads management, Excel admin-kundali
settings. Every Phase 3+ feature must land in both N and P or be explicitly listed as
a parity exception.

## 1. Feature/status map by master-prompt phase

### Phase 3 — Pandit availability calendar — **IMPLEMENTED (Phase 3 complete)**
| Aspect | Finding |
|---|---|
| Was | `pandits.off` per-date toggle + slot-conflict only; no weekly off, slots, holidays, blocked dates, radius or capability flags |
| Now | Migration 013 extends the SAME pandits table (weekly_off, slots, holidays, blocked_dates with reasons, radius_km + base coords, online/temple flags — all permissive defaults so existing data is untouched). ONE engine: `server/services/availability.js` + twin `backend-python/app/services/availability.py` with the ordered bookable formula (KYC → avail → weekly off → holiday → blocked → marked-off → slot → online/temple → home radius → conflict) returning WHY on every NOT BOOKABLE. Booking creation, reschedule and admin assignment all consult it; auto-assign honours radius and capabilities; `GET /pandit/calendar`, `PUT /pandit/calendar`, `POST /pandit/calendar/dates`, `GET /pandit/calendar/why` (both backends); customer `GET /pandits/available` (Node: mounted via customerPaths). Pandit portal: rules editor (weekly off, slots, flags, radius + base city) and month grid with date actions (toggle/holiday/block-with-reason). Legacy date-toggle un-blocks structured entries. DB partial unique index remains the hard double-booking guarantee. |

### Phase 4 — Pandit KYC — **IMPLEMENTED (Phase 4 complete)**
| Aspect | Finding |
|---|---|
| Was | Binary approve/reject on `pandits.kyc` JSON; no per-document records, expiry or reminders |
| Now | `kyc_documents` (014) activated: per-document upload (pandit portal Profile tab; magic-byte + PDF checks, 8 MB cap), full vocabulary PENDING/UNDER_REVIEW/VERIFIED/REJECTED/EXPIRED/REVERIFICATION_REQUIRED (+SUPERSEDED history), re-upload supersedes the open copy keeping history, admin decisions require reasons the pandit sees, expiry sweep + 30-day reminders surface in the admin KYC tab and notify the pandit, the sweep also runs on a schedule (unref'd interval armed at boot, `KYC_SWEEP_MS` default 6h, 0 disables — reminders fire with zero admin traffic), every decision audited with old→new status + reason, admin document download endpoint. `services/kyc.js` + twin `services/kyc.py`; closes the Python pandit-upload parity gap |

### Phase 5 — Pandit profile — **IMPLEMENTED (Phase 5 complete)**
| Aspect | Finding |
|---|---|
| Was | Missing photo, gotra/lineage, qualifications, QA score, cancellation/no-show % |
| Now | Migration 016 extends the SAME pandits row: `photo_file` (magic-checked image upload, stored under media/ so it is publicly served from /media like catalogue photos; KYC files stay private), `gotra`, `qualifications`, `veda_school`, cached `qa_score`. Profile PATCH accepts gotra/quals/veda (length-capped); pandit profile tab has photo upload + the new fields; public pandit profile shows photo, gotra/tradition/qualifications card and QA score. Cancellation% (cancelled while assigned to this pandit) and no-show% (past scheduled date, assigned, never Started/Completed) are DERIVED from bookings on read — never stored — and surface on the QA endpoints (`GET /admin/pandits/:id/qa`, `GET /pandit/me/qa`) and the growth tab. `services/qa.js` + twin `app/services/qa.py` |
| Status | **IMPLEMENTED** |

### Phase 6 — Service photo date gate — **IMPLEMENTED (Phase 6 complete)**
| Aspect | Finding |
|---|---|
| Was | Pandit photos tab: upload against own assigned booking, admin moderation, delete-own-pending; `puja_media` + metadata (010) + variants (011); sharp pipeline — but **no scheduled-date validation** (upload any time), no admin override concept |
| Now | Migration 017 adds `bookings.media_override` (admin-granted exception; lives on the BOOKING because it must exist before the upload) and `puja_media.upload_date` (server-computed booking.date snapshot for the admin view). `services/pujaMedia.js` + twin `app/services/media.py`: pandit upload throws 400 `Photos can only be uploaded on the scheduled puja date — ask the admin for an override` unless `booking.date == today` or the booking is overridden; upload audit detail gains `dateGate: on_date\|admin_override`. Admin route `POST /admin/bookings/:id/media-override` (`{enable}`; default true, `enable:false` revokes) audits `media.date_gate_override` with old→new mediaOverride. Admin photo manager shows pandit uploads with upload timestamp, actor (uploadedBy) and the puja-date snapshot; pandit photos tab marks each booking `uploadable today / not yet / override ✓` and the admin bookings row carries an Allow/Revoke-photo-override action. `tests/mediagate.test.js` + `test_mediagate.py` pin the gate message, the override round-trip, both audits, ownership/role and the attribution view |
| Status | **IMPLEMENTED** |

### Phase 7/8 — Earnings & payout engine — **FOUNDATION COMPLETE (Phase 31-adjacent, done first)**
| Aspect | Finding |
|---|---|
| Was | `payouts(id, pandit_id, amount, date, status, booking_id)`; Pending/Paid only; commission from `getSetting('commission', 20)` (settings-driven) |
| Now | `server/services/payoutEngine.js` + Python twin `services/payout_engine.py`: canonical statuses PENDING/ON_HOLD/PROCESSING/DISBURSED/FAILED/REVERSED, hold reasons + notes (pandit-visible), money trail (gross/commission/tax/refund/adjustment → net), processing/disbursement dates, payment ref + UTR, settings-driven hold rules (`payout_holds`), auto-hold for unverified-pandit payouts, transitions audited with old→new status; migration 012; finance tab lifecycle UI; pandit earnings tab shows full breakdown + WHY on hold; `payout-audit` report id in both registries |

### Phase 9 — Commission tiers — **IMPLEMENTED (Phase 9 complete)**
| Aspect | Finding |
|---|---|
| Was | Single `commission` setting; `commission_tiers` table scaffolded (migration 014, empty) |
| Now | `services/ledger.js` + twin `app/services/ledger.py`: `resolveTier(panditId, category, date)` returns the active tier whose effective window covers the date (NULL = open), exact category before 'ALL', newest `effective_from` first; `commissionPct()` consults it on every payout creation with the settings knob as fallback — payouts only change rate when an admin defines a tier. Admin CRUD (`GET/POST/PATCH /admin/commission-tiers`) validates pct 0–90 and pct+share ≤ 100 and audits `commission.tier_created` / `commission.tier_updated` on entity `commission_tier`. Finance tab: tier table with activate toggles + create form. `tests/ledger.test.js` + `test_ledger.py` cover resolver precedence, windows, CRUD and the payout-engine consuming the tier |
| Status | **IMPLEMENTED** |

### Phase 10 — Transactions ledger — **IMPLEMENTED (Phase 10 complete)**
| Aspect | Finding |
|---|---|
| Was | `payments` table; bookings carry pay JSON; `transactions` table scaffolded (migration 014, empty) |
| Now | `services/ledger.js` + twin `app/services/ledger.py` activate the SAME table: types SERVICE_PAYMENT / KUNDALI_PAYMENT / DAKSHINA / REFUND / COMMISSION / PAYOUT, signed from the platform's perspective (inflows +, REFUND/PAYOUT −), one row per (type, ref_table, ref_id) so payment retries and transition replays never double-count. Writes: booking payment confirmation (mock bookings settle at creation, gateway ones at /payments/verify), cancellation refunds (inside the cancel transaction), kundali payments (mock at generate, gateway at /pay/verify), payout engine — DAKSHINA (the pandit's share) at payout creation, COMMISSION + PAYOUT on disburse, DAKSHINA delta on adjustment. Admin `GET /admin/ledger` (entries + totals with inflow/outflow split), pandit `GET /pandit/me/ledger`, finance-tab ledger view + pandit earnings Dakshina KPIs, and report ids `dakshina` (earnings vs disbursements per pandit) + `transactions` (typed filter) in both registries. `tests/ledger.test.js` + `test_ledger.py` cover the money paths, dedupe idempotency and reports |
| Status | **IMPLEMENTED** |

### Phase 11 — Puja pricing management — **IMPLEMENTED (Phase 11 complete)**
| Aspect | Finding |
|---|---|
| Was | Admin pujas tab: per-puja price edit, hide/show, add-puja form, categories, Hindi names (007) — price+visibility only, no per-mode pricing or mode availability; Python had NO puja admin routes at all |
| Now | Migration 020 adds `pujas.price_home/online/temple/custom` (NULL = legacy formula `round(price × modeFactor × pf / 10) × 10`; explicit values are FLAT — the pf multiplier does not apply) + `pujas.modes` (JSON list of bookable types). Both pricing engines (`shared/pricing.js` + `app/pricing.py`) take an optional `modePrice` in the quote ctx — existing call sites unchanged. `priceRequest` (both twins) resolves `price_{mode}` and refuses modes outside the list. Admin: Node PATCH extended + `puja.create`/`puja.update` audits ADDED (were missing); Python gains POST/GET/PATCH `/admin/pujas` from scratch with the same audits. Serializer exposes `priceHome/Online/Temple/Custom` + `modes` (both twins). FE: puja edit modal gains four per-mode price inputs (blank = auto) + bookable-type checkboxes; add-puja form gains the mode chips. `tests/pricing.test.js` + `test_pricing.py` pin engine parity (flat override, pf ignored, null parity), quote/booking resolution, mode gating (quote + create), clear-back-to-formula, serializer fields and the audits |
| Status | **IMPLEMENTED** |

### Phase 12 — Temple management — **IMPLEMENTED (Phase 12 complete)**
| Aspect | Finding |
|---|---|
| Was | `temples` table + temple_pujas; FE temple directory; admin pujas tab showed temples **read-only**; booking checked `temples.pujas` for temple-mode availability — add/edit/activate/photos all missing |
| Now | Migration 019 extends the SAME temples row: `active` (delist flag), `timings`, `photo`. Admin CRUD `GET/POST/PATCH/DELETE /admin/temples` (Node + NEW Python routes — P had zero): create validates the puja set against the catalogue, PATCH is field-conditional, DELETE answers 409 when bookings reference the temple (`Deactivate it instead.`) — the active flag delists without breaking past bookings. Every write audited (`temple.create/update/delete`). Gating (both twins): the customer state payload lists only `active=1` temples, `priceRequest` counts only active temples for temple-mode availability, `createBooking` refuses delisted temples with the existing message. FE: admin pujas tab temples table gains status badge + Edit/Delist-Relist/Delete actions + an Add-temple form (name, city, deity, timings, description, puja chips); Edit modal carries all fields incl. listing toggle + photo URL; public temple directory shows timings (🕙) and the photo when set. `tests/temple.test.js` + `test_temple.py` cover CRUD + validation, audits, the active-flag gate (directory hidden + priceRequest unavailable + createBooking refused, relist restores), delete protection, and access control |
| Status | **IMPLEMENTED** |

### Phase 13 — NRI packages
| Aspect | Finding |
|---|---|
| Existing | Nothing |
| Status | **MISSING** |
| Required | `nri_packages` table + admin CRUD + checkout path honoring package pricing/currency (kundali billing already has currency — reuse patterns) |

### Phase 14 — Coupons
| Aspect | Finding |
|---|---|
| Existing | `coupons(code, type, val, max, min, active, used)`; validated in `priceRequest()` via `shared/pricing.couponProblem()`; admin create/toggle in finance tab |
| Status | **PARTIAL** — global scope only; no applicability (PUJA/KUNDALI/PRASAD/service targeting), no date window, no per-customer limit |
| Required | Add scope columns to existing coupons table + validation in all three checkout paths (booking, kundali, orders); admin form fields |

### Phase 15 — Kundali history
| Aspect | Finding |
|---|---|
| Existing | `kundalis` table keyed to `customer_id`, full chart/panchang/dosh/recommendations persisted; `GET /kundali/mine` + customer account view; admin kundalis report; family members linked |
| Status | **WORKING** — linkage exists; needs only richer history view (filters) if desired |
| Required | Small FE polish; no schema work |

### Phase 16 — Cancellation/rescheduling engine — **IMPLEMENTED (Phase 16 complete)**
| Aspect | Finding |
|---|---|
| Was | Tiered refunds in `cancelInternal()` (100/75/50% enforced server-side, customer-side only), refund states, reschedule in booking log, expire-unpaid sweep |
| Now | `services/cancellation.js` + twin `app/services/cancellation.py` are the ONE cancellation writer (bookings.js/bookings.py keep aliases so expire-unpaid, admin status, gateway-rollback and customer-cancel call sites are unchanged). Refund windows/percentages are settings-backed policy `cancellation_policy` {full, part, fullPct, partPct, latePct, noshowPct, compPct, noticeHours} carrying the exact legacy defaults — behaviour only changes when an admin edits it; `cancellation_policy` rides the admin state payload (`set.cxp`). New: `POST /pandit/bookings/:id/cancel` (customer always refunded at the standard tier; pandit compensation `compPct` of their share via a real PENDING payout + deduped DAKSHINA ledger row only OUTSIDE the `noticeHours` window; booking keeps pandit_id so QA cancelPct attributes it; started pujas refuse), no-show sweep past-due active bookings (boot-armed via NOSHOW_SWEEP_MS default 1h in both backends — same scheduler contract as the KYC sweep; Python adds `noshow_sweep_tick` to the existing scheduler), `POST /admin/bookings/:id/noshow` (customer refunded `noshowPct`, pandit compensated, audited), `GET/PUT /admin/cancellation-policy` (pct fields 0–100, hour windows to a year, full>part enforced, audited old→new). Every cancellation — customer, admin, pandit, no-show, expire-unpaid — is audited through the single writer. `tests/cancellation.test.js` + `test_cancellation.py` cover policy bounds/audit, tier-from-policy, refund ledger, pandit-cancel compensation both ways, admin no-show and sweep idempotency |
| Status | **IMPLEMENTED** |

### Phase 17 — QA & rating engine — **IMPLEMENTED (Phase 17 complete)**
| Aspect | Finding |
|---|---|
| Was | No punctuality/compliance breakdown, no QA score, no admin QA history |
| Now | `qa_records` (migration 016): one admin-scored observation per booking across the 7-dimension trial-pooja rubric (punctuality, communication, ritual_compliance, presentation, customer_interaction, digital_capability, documentation; each 1..5). `overall` is computed server-side as the mean of the supplied dimensions; `pandits.qa_score` is a cached average refreshed on every write (customer reviews keep driving `pandits.rating` unchanged). Endpoints (both backends): `GET /admin/qa`, `POST /admin/qa` (201), `DELETE /admin/qa/:id` (score recomputed), `GET /admin/pandits/:id/qa`; pandit self-view `GET /pandit/me/qa`. Every write audited (`qa.recorded`/`qa.deleted` with old/new values); the pandit is notified with the overall score. Admin portal: Service quality tab (records table + record form + per-pandit drill-down); pandit Growth tab shows QA score, derived cancellation/no-show % and own QA history |
| Status | **IMPLEMENTED** |

### Phase 18 — Trial pooja — **IMPLEMENTED (Phase 18 complete)**
| Aspect | Finding |
|---|---|
| Was | No application code; `trial_poojas` table scaffolded (migration 014, empty; model already mirrored) |
| Now | `services/trial.js` + twin `app/services/trial.py` activate the SAME table (no schema change). Admin schedules a trial (pandit, date, service) → assesses it with ALL 7 rubric dimensions (same axes as qa_records; 1..5; partial scoring refused — an activation decision never rests on a partial picture) → `final_score` = mean; result vocabulary PENDING/PASSED/FAILED/REASSESSMENT_REQUIRED with the pass mark from the `trial_pass_mark` setting (default 3.5); PASSED is computed, never forced; REASSESSMENT_REQUIRED requires written feedback the pandit sees. THE ACTIVATION GATE: `POST /admin/pandits/:id/kyc` refuses status='verified' (Node, and the new Python-parity route) until the pandit has a PASSED trial — explicit 409 with the blocking reason (none assessed / pending / ended FAILED / ended REASSESSMENT_REQUIRED); already-verified pandits are grandfathered; gate decisions audited. Endpoints (both backends): `GET /admin/trials[?panditId]`, `POST /admin/trials` (201), `POST /admin/trials/:id/record`; pandit self-view `GET /pandit/me/trial`. Admin KYC tab: trials section with schedule form, record-assessment modal (7 inputs + notes), result badges + gate explainer; pandit Growth tab: latest trial result + feedback. Audits `trial.scheduled` / `trial.recorded` with old→new; the pandit is notified on schedule and on every result. `tests/trial.test.js` + `test_trial.py` cover the full gate matrix |
| Status | **IMPLEMENTED** |

### Phase 19 — Complaints
| Aspect | Finding |
|---|---|
| Existing | `tickets` + `ticket_messages` + `login_activity`; customer submit from booking; admin resolve button |
| Status | **PARTIAL** — Open/Resolved only; master workflow OPEN→UNDER_REVIEW→PANDIT_RESPONSE→CUSTOMER_RESPONSE→DECISION→RESOLVED not implemented; no evidence attachments |
| Required | Extend tickets status vocab + admin workflow controls + attachments (reuse media upload path) |

### Phase 20 — Incident reporting — **IMPLEMENTED (Phase 20 complete)**
| Aspect | Finding |
|---|---|
| Was | No application code; `incidents` table scaffolded (migration 014, empty; model already mirrored) |
| Now | `services/incidents.js` + twin `app/services/incidents.py` activate the SAME table (no schema change). The PANDIT assigned to a booking reports against it — booking reference optional but ownership-enforced (another pandit's booking → 400, unknown → 404; the customer is linked from the booking automatically). Fixed category vocabulary SAFETY_CONCERN / CUSTOMER_CONDUCT / PAYMENT_ISSUE / SAMAGRI_ISSUE / OTHER; description mandatory (≥10 chars). Evidence rides the EXISTING magic-checked media pipeline (images + video, 40 MB): multipart directly on `POST /pandit/incidents`, or the evidence-only `POST /pandit/incident-evidence` → `/media/` urls (the FE modal does the latter); the service keeps only `/media/` strings (max 8, 200 chars each) — client-supplied paths are never trusted. Admin triage OPEN → UNDER_REVIEW → RESOLVED \| DISMISSED: UNDER_REVIEW requires an admin note, RESOLVED requires the resolution the pandit sees (+ resolved_at), DISMISSED requires a reason; closed states are terminal (409 — the audit trail keeps the history). Endpoints (both backends): `GET /admin/incidents[?status]` (with per-status counts + categories), `PATCH /admin/incidents/:id`; pandit `GET /pandit/me/incidents` (own reports only), `POST /pandit/incidents`. Audits `incident.reported` / `incident.triage` (actor = the pandit's USER id so the role derives correctly; old→new); all admin users are notified in-app on a new report and the pandit on every triage decision. Admin Support tab: incident KPIs + gate explainer + triage table (Review/Resolve/Dismiss) above the tickets table; pandit Bookings card: "Report incident" on live bookings (follow-up fix: the modal's evidence upload authenticated with `session.token`, which the state payload never carried — 401 on every attach; now uses the shared `token` global). Follow-up (migration 018): DISMISSED is no longer terminal — `POST /admin/incidents/:id/reopen` (both backends) requires an admin reason, returns the incident to UNDER_REVIEW, stamps `reopen_count`/`reopen_reason` (latest wins), audits `incident.reopened` with old→new, notifies the pandit; RESOLVED stays final; support rows carry a Reopen action + a `↻ reopened ×N` chip. `tests/incident.test.js` + `test_incident.py` cover reporting/ownership/validation, evidence upload + filtering, the full triage matrix with audits + notifications, the reopen path (source-state limits, reason validation, counter increments, audits), and access control |
| Status | **IMPLEMENTED** |

### Phase 21 — RBAC
| Aspect | Finding |
|---|---|
| Existing | Roles: admin/customer/pandit via JWT; admin-only exports audit-logged; pandit portal shows masked mobiles; no FINANCE/CUSTOMER_SUPPORT/SUPER_ADMIN, no permission matrix |
| Status | **PARTIAL** |
| Required | Extend users role vocab + permission map (pandit must never export); permission checks in admin routes by sub-role |

### Phase 22 — Pandit account status — **IMPLEMENTED (Phase 22 complete)**
| Aspect | Finding |
|---|---|
| Was | Login-level suspension only (009); no lifecycle with reasons/dates/payout linkage |
| Now | Migration 015 adds account_reason/_from/_to/_review_date/_note to pandits. `services/accountStatus.js` + twin: ACTIVE/UNDER_REVIEW/SUSPENDED/TERMINATED (ACTIVE == 'verified'; onboarding states untouched). Suspension/termination block login immediately (existing tokens revoked by the 009 re-check), block booking via the availability engine (ACCOUNT code with the reason), and HOLD open payouts (Admin Hold + documented reason; legacy 'Pending' rows included). Termination is final (no reinstatement). Reinstatement clears the columns and releases held payouts to PROCESSING. Every transition audited old→new lifecycle + reason. Admin pandits tab shows lifecycle badges + Suspend/Reinstate/Terminate actions |

### Phases 23–25 — Agreements — **IMPLEMENTED (Phases 23-25 complete)**
| Aspect | Finding |
|---|---|
| Existing | `agreements` + `agreement_acceptances` TABLES ALREADY CREATED (migration 014, empty; unique index version-locks acceptance) |
| Now | `services/agreements.js` + twin (`services/agreements.py`) activate both tables. Version rows, never mutated after publishing: drafts get version = max+1; publishing stamps published_at + document_hash = sha256(body) (manual upload hashes the file bytes); ARCHIVED/PUBLISHED cannot re-publish; versions WITH acceptances can never be archived — a new version supersedes instead, old acceptances stay queryable per pandit. Pandit flow: `GET /pandit/agreement` (current + my acceptance history) → consent checkbox → OTP issued via the existing `POST /auth/otp/send` to `pandits.mobile` → `POST /pandit/agreement/accept` verifies via auth.js `verifyOtp` (Python: services/otp.verify) and inserts method 'DIGITAL' + otp_verified + IP + device; the migration-014 unique index makes a repeat 409 (unknown and unpublished ids both 404). Manual upload path: admin posts a signed PDF/image to `POST /admin/agreements/file` (multer+magic-byte / %PDF-+verify_upload checks, stored under uploads/agreements) — published as its own version, no OTP row fabricated. Every action audited enriched: agreement.created/published (hash in new_value)/archived/accepted (OTP flag, version, hash, IP + device in the audit row). Admin Agreements tab (ANAV) with versions, acceptances drill-down, draft editor, manual upload; pandit portal Agreement tab (PNAV) with consent + OTP flow |
| Status | **IMPLEMENTED** — `tests/agreements.test.js` (Node) + `backend-python/tests/test_agreements.py` (twin) |

### Phase 26 — Leads
| Aspect | Finding |
|---|---|
| Existing | `leads(id, type, name, details, date)` minimal; captured from enquiries; admin support tab lists; leads report exists |
| Status | **PARTIAL** |
| Required | Extend columns (mobile/email/source/interested service/location/assigned employee/status/follow-up/notes/conversion/booking_id) + filter/export |

### Phases 27–29 — Communication / campaigns / notifications
| Aspect | Finding |
|---|---|
| Existing | `notify.js` in-app notifications + `notifs` table; `campaigns(id,name,channel,audience,status,sent)` minimal; admin marketing tab: create campaign, push broadcast, banners |
| Status | **PARTIAL** — WhatsApp/SMS/Email are labels only (no senders); campaigns have no lifecycle (DRAFT…COMPLETED); no Excel-upload source |
| Required | One notification engine service (channel adapters, provider-gated); campaign lifecycle state machine; Excel import with validation/dedupe preview mapping to existing customers/leads |

### Phase 30 — Reports
| Aspect | Finding |
|---|---|
| Existing | 27 report ids, Exceljs/openpyxl twin implementations, export audit log, filters |
| Status | **WORKING** — extend registry for new modules (KYC, incidents, agreements, transactions/Dakshina, commission tiers, NRI packages) |

### Phase 31 — Audit log — **FOUNDATION COMPLETE (done first)**
| Aspect | Finding |
|---|---|
| Was | `audit_logs` + admin audit tab; all exports and sensitive account actions logged; no old/new value, reason, IP, device |
| Now | Migration 012 adds old_value/new_value/reason/ip/device (both backends); central helpers (`lib/audit.js` / AuditLog writes) persist them; commission + coupon + KYC + account-status + payout actions write old→new values and reasons; `GET /admin/audit` returns the enriched shape (new Python endpoint — closes a parity gap); FE audit tab displays reason |

### Phase 32 — Dashboard
| Aspect | Finding |
|---|---|
| Existing | Admin dashboard KPIs (bookings, gross, commission, active pandits, KYC pending, unassigned, tickets, refunds) |
| Status | **PARTIAL** — add pending agreements, today's pujas/revenue, payout pending/on-hold, incidents, campaigns, leads, kundalis-generated |

### Phases 33–37 — Validation, security, dedup, regression, quality
- **Phase 34 security harness IN PLACE (landed early with migration 014):**
  `tests/security.test.js` (Node, 4 tests) + `backend-python/tests/test_security.py` (3 tests)
  — pandit/customer cannot reach exports or admin reads (403/401 asserted per path),
  cross-role isolation (cancel/accept/audit-trail ownership), duplicate booking
  (DB constraint), duplicate payment (Razorpay signature replay is idempotent),
  duplicate payout disbursement (engine refuses transitions out of DISBURSED),
  kundali idempotency-key replay, and malformed/injection-shaped input handling.
  Later phases must keep these green; new endpoints inherit the guards.
- **Migration 014 scaffolding created (empty, unused until each phase lands):**
  kyc_documents [4], commission_tiers [9], transactions [10], incidents [20],
  agreements + agreement_acceptances (version-locked unique index) [23-25],
  trial_poojas [18] — SQLAlchemy models mirrored.
- E2E workflows to script-test: onboarding, booking (with availability), customized puja, KYC, agreement, payout.
- Duplication sweep after implementation; no dead code/placeholder buttons (FE note: analytics "Sample" KPI and incentives text are static copy — verify and either wire or label).

### Phase 36 — Do-not-break list
Demo accounts (`u1`, `p1`, admin env creds, OTP 123456 demo mode), demo reset, mock
bookings, kundali free-quota model, existing 27 reports, media pipeline, both test
suites — all must stay green after every phase.

## 2. Duplication map (Phase 1) — known forks to keep single-source

| Function | Single source | Duplication risk to avoid |
|---|---|---|
| Pricing/quote | `shared/pricing.js` | Never re-derive commission/discount in services |
| Commission | `getSetting('commission')` → payout engine | Do not introduce a second constant |
| Availability | `services/availability.js` + Python twin `services/availability.py` | All bookable checks go INSIDE the engine; `is_free`/`auto_pick` are thin delegates |
| Payout math/statuses | `services/payoutEngine.js` + Python twin | No inline commission math, no direct payouts UPDATE outside transitions |
| Refunds | `cancelInternal()` | No parallel refund writer |
| Excel export | REPORTS registry + xlsx port | New reports added to BOTH registries, not ad-hoc |
| Notifications | `notify.js` | No per-module notification logic |
| Audit | `lib/audit.js` helper (N) / AuditLog writes (P) | No direct audit_logs INSERTs scattered; enriched fields via the helpers |

## 3. Migration safety (Phase 2)

Migrations 001–014 exist and are idempotent-ordered (012 audit/payout, 013
availability, 014 scaffolding tables). Baseline rules going forward:
1. Every new column/table checked against the inventory above first (`IF NOT EXISTS`).
2. No destructive changes to users/pandits/bookings/payments/kundalis/coupons data.
3. SQLite migration + mirrored SQLAlchemy models in the same commit; both test suites
   seeded/verified after each migration.
4. Extension-first, as demonstrated: 013 added availability COLUMNS to `pandits`
   rather than a parallel availability table (the once-planned `pandit_availability`
   table is superseded by that decision). Remaining genuinely-new entities:
   `nri_packages` [13] and possibly `qa_records` [17]; everything else already has a
   scaffolded table from 014 or extends existing columns.

## 4. Build order (confirmed — dependency-driven, always Node+Python+FE together)

Sequencing decision: phases land in BOTH backends every time (no parity debt), in
this order:

```
DONE:  31 audit → 7/8 payout engine → 3 availability → 34 harness + 014 scaffolding
NEXT:  4 KYC ─┬→ 22 account status      (same screens; feeds the payout auto-hold
              │                          that already checks pandit KYC)
       5 profile ─→ 17 QA engine          (same pandit surfaces)
       9 tiers + 10 transactions ledger   (engine consumes the tier resolver;
                                           ledger exists before cancellation rewrites)
       16 cancellation engine             (writes REFUND/ADJUSTMENT ledger entries)
       18 trial ─→ 23-25 agreements       (completes onboarding: KYC→agreement→trial→activation)
       20 incidents · 6 photo date gate   (small, standalone; audit ready for overrides)
       12 temples · 11 puja pricing · 13 NRI · 14 coupons   (admin CRUD cluster)
       26 leads · 27-29 comms/campaigns/notifications        (largest build)
LAST:  15 polish · 30 reports (absorb all new modules) · 32 dashboard (aggregates all)
       33/35/36/37 sweeps → 38 delivery report
```

Rationale: money-adjacent phases precede the onboarding chain because payout holds
and the ledger are already wired; reports (30) and dashboard (32) go last because
they aggregate every other phase — building them early guarantees rework.
