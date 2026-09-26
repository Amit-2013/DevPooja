/* Centralized pandit availability engine (master plan Phase 3).
   ONE module answers "can this pandit take this booking?" for every path:
   customer booking, auto-assignment, admin assignment, rescheduling.

   Check order (first failure wins, each with a human-readable reason):
     1  pandit exists
     2  KYC status verified
     3  accepting bookings (avail flag)
     4  weekly off            (weekly_off, JSON array of 0=Sun..6=Sat)
     5  holiday               (holidays, JSON array of ISO dates — recurring meaning)
     6  blocked date          (blocked_dates, JSON array of ISO dates + reason)
     7  marked-off date       (existing pandits.off — legacy single-date off)
     8  time slot             (slots, JSON array; empty = all shared SLOTS)
     9  online capability     (online_enabled)
     10 temple capability     (temple_enabled)
     11 home-puja radius      (radius_km + base coords; NULL = not enforced)
     12 slot conflict         (existing partial unique index is the last line of defense)

   Defaults are deliberately permissive: empty arrays / NULLs mean "no restriction",
   so existing pandits and seeded data behave exactly as before (Phase 36). */
'use strict';
const { db } = require('../db');
const { j } = require('../lib/util');
const P = require('../../shared/pricing');

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* Haversine distance in km (never imported — one tiny local helper). */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* Resolve a booking location (from a booking row or a request body) to coords.
   Tolerant city match: 'Delhi NCR' matches place_index 'Delhi'. */
function resolvePlace(city) {
  if (!city) return null;
  const row = db.prepare(`SELECT lat, lon FROM place_index WHERE country='India' AND
    (city = ? OR ? LIKE city || ' %' OR city LIKE ? || ' %') ORDER BY population DESC LIMIT 1`)
    .get(city, city, city);
  return row || null;
}

/* The bookable formula. mode may be undefined for legacy checks (slot-only). */
function check(p, date, slot, { mode, city, lat, lon, skipId } = {}) {
  if (!p) return { ok: false, reason: 'Pandit not found', code: 'NOT_FOUND' };
  if (p.status !== 'verified') return { ok: false, reason: 'KYC verification pending', code: 'KYC' };
  if (!p.avail) return { ok: false, reason: 'Pandit is not accepting new bookings', code: 'AVAIL_FLAG' };

  const weekly = j(p.weekly_off, []);
  const wd = new Date(date + 'T12:00:00Z').getUTCDay();
  if (weekly.includes(wd)) return { ok: false, reason: WD[wd] + ' is a weekly off for this pandit', code: 'WEEKLY_OFF' };

  const holidays = j(p.holidays, []);
  if (holidays.includes(date)) return { ok: false, reason: 'Pandit is on holiday on this date', code: 'HOLIDAY' };

  const blocked = j(p.blocked_dates, []);
  const hit = blocked.find((b) => (b && b.date) === date);
  if (hit) return { ok: false, reason: 'Date blocked by the pandit' + (hit.reason ? ': ' + hit.reason : ''), code: 'BLOCKED' };

  if (j(p.off, []).includes(date)) return { ok: false, reason: 'Pandit marked this date unavailable', code: 'MARKED_OFF' };

  const configured = j(p.slots, []);
  if (slot && configured.length && !configured.includes(slot)) {
    return { ok: false, reason: 'Pandit does not take bookings in the ' + slot + ' slot', code: 'SLOT' };
  }

  if (mode === 'online' && !p.online_enabled) return { ok: false, reason: 'Pandit does not offer online pujas', code: 'ONLINE_OFF' };
  if (mode === 'temple' && !p.temple_enabled) return { ok: false, reason: 'Pandit does not offer temple services', code: 'TEMPLE_OFF' };

  if (mode === 'home' && p.radius_km != null) {
    const base = (p.base_lat != null && p.base_lon != null)
      ? { lat: p.base_lat, lon: p.base_lon }
      : resolvePlace(p.city);
    if (!base) return { ok: false, reason: 'Pandit base location is unknown; radius cannot be checked', code: 'RADIUS' };
    let dest = (lat != null && lon != null) ? { lat: Number(lat), lon: Number(lon) } : null;
    if (!dest) {
      const reqCity = city || (() => { const b = db.prepare("SELECT addr FROM bookings WHERE id=?").get(skipId || ''); return b ? (j(b.addr, {}).city) : null; })();
      dest = resolvePlace(reqCity);
    }
    if (!dest) return { ok: false, reason: 'Location is outside the pandit\u2019s service area', code: 'RADIUS' };
    const km = haversineKm(base.lat, base.lon, dest.lat, dest.lon);
    if (km > p.radius_km) {
      return { ok: false, reason: 'Location is ' + Math.round(km) + ' km away, beyond the pandit\u2019s ' + p.radius_km + ' km service radius', code: 'RADIUS' };
    }
  }

  /* Slot conflict LAST: the DB partial unique index remains the hard guarantee. */
  if (slot) {
    const c = db.prepare("SELECT 1 FROM bookings WHERE pandit_id=? AND date=? AND slot=? AND status NOT IN ('Cancelled') AND id != ?")
      .get(p.id, date, slot, skipId || '');
    if (c) return { ok: false, reason: 'Already booked in the ' + slot + ' slot on this date', code: 'CONFLICT' };
  }
  return { ok: true, reason: 'Available', code: 'OK' };
}

/* Boolean twin of check() for drop-in use at legacy call sites. */
function isFree(p, date, slot, opts = {}) { return check(p, date, slot, opts).ok; }

/* Best-pandit picker honoring availability, then spec/city/rating as before. */
function autoPick(pujaId, city, date, slot, { mode, lat, lon } = {}) {
  const list = db.prepare("SELECT * FROM pandits WHERE status='verified'").all()
    .filter((p) => isFree(p, date, slot, { mode, city, lat, lon }));
  list.sort((a, b) => (j(b.spec, []).includes(pujaId) - j(a.spec, []).includes(pujaId))
    || ((b.city === city) - (a.city === city)) || b.rating - a.rating);
  return list[0] || null;
}

/* Which pandits can take (puja, mode, date, slot)? Powers the customer wizard's
   "available pandits" UX. Returns rows with a machine + human reason each. */
function whoIsAvailable(pujaId, city, date, slot, { mode, lat, lon } = {}) {
  return db.prepare("SELECT * FROM pandits WHERE status='verified'").all()
    .map((p) => ({ p, r: check(p, date, slot, { mode, city, lat, lon }) }))
    .filter((x) => x.r.ok)
    .sort((a, b) => (j(b.p.spec, []).includes(pujaId) - j(a.p.spec, []).includes(pujaId))
      || ((b.p.city === city) - (a.p.city === city)) || b.p.rating - a.p.rating)
    .map((x) => x.p);
}

/* Availability configuration for the pandit portal / admin screens. */
function configOf(p) {
  return { weeklyOff: j(p.weekly_off, []), slots: j(p.slots, []), holidays: j(p.holidays, []),
           blockedDates: j(p.blocked_dates, []), radiusKm: p.radius_km != null ? p.radius_km : null,
           baseLat: p.base_lat, baseLon: p.base_lon,
           onlineEnabled: !!p.online_enabled, templeEnabled: !!p.temple_enabled };
}

module.exports = { check, isFree, autoPick, whoIsAvailable, resolvePlace, haversineKm, configOf };
