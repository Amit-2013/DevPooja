/* Phase 21 - RBAC permission map (single source for the Node backend).
   Mirrored by backend-python/app/permissions.py - change both together.

   Role vocabulary (users.role, free TEXT - no schema change):
     customer | pandit   - the two non-privileged portals
     admin               - FULL access to every admin capability
     finance             - the money group only (payouts, commission, ledger,
                           refunds, finance-domain reports + their exports)
     customer_support    - the service group only (bookings, reviews, tickets,
                           incidents, leads, accounts, orders, custom requests,
                           kundali analyses)
   ADMIN_FAMILY = the roles allowed to enter /api/admin at all; a router-level
   guard answers every request from this map. The DEFAULT is admin-only, so a
   new admin route is admin-only until it is deliberately classified here
   (platform = catalogue, CMS, media, pandit governance, campaigns, settings,
   demo, audit, role changes, exports).

   Exports are the most sensitive surface: a pandit or customer never reaches
   the admin router, customer_support never exports, and finance exports only
   the finance-domain reports. */
'use strict';

const ADMIN_FAMILY = ['admin', 'finance', 'customer_support'];
/* Assignable targets of POST /admin/users/:id/role - pandit stays out: it is a
   profile-linked portal role, not an operations seat. */
const ASSIGNABLE = ['admin', 'finance', 'customer_support', 'customer'];

const MONEY_PREFIXES = ['/payouts', '/payout-rules', '/commission-tiers', '/ledger'];
const SUPPORT_PREFIXES = ['/bookings', '/reviews', '/tickets', '/incidents', '/leads',
  '/accounts', '/users', '/orders', '/custom-requests', '/kundali/analyses'];
/* Reports finance may read AND export (everything else is admin-only). */
const FINANCE_REPORTS = ['payments', 'payouts', 'payout-audit', 'dakshina', 'transactions',
  'revenue', 'commission', 'refunds', 'customer-accounts', 'pandit-accounts',
  'coupon-redemptions', 'coupon-usage'];

const isFamily = (role) => ADMIN_FAMILY.includes(role);
const segs = (p) => String(p || '/').split('/').filter(Boolean);
const hit = (p, pre) => p === pre || p.startsWith(pre + '/');

/* Route path (relative to /api/admin) to capability group. Ordered rules; the
   default keeps unclassified routes admin-only. */
function groupFor(path) {
  const p = String(path || '/');
  const s = segs(p);
  if (p.startsWith('/export/')) return 'export';
  if (s.length === 3 && s[0] === 'users' && s[2] === 'role') return 'platform'; /* only a full admin hands out seats */
  if (s.length === 3 && s[0] === 'bookings' && s[2] === 'refund') return 'money'; /* money exception in the bookings namespace */
  for (const pre of MONEY_PREFIXES) if (hit(p, pre)) return 'money';
  for (const pre of SUPPORT_PREFIXES) if (hit(p, pre)) return 'support';
  return 'platform';
}

/* Can this role act on a group? ('export' is answered by canExport). */
function can(role, group) {
  if (role === 'admin') return true;
  if (role === 'finance') return group === 'money';
  if (role === 'customer_support') return group === 'support';
  return false; /* customer / pandit / anything new: never inside the admin API */
}

function canExport(role, reportId) {
  if (role === 'admin') return true;
  if (role === 'finance') return FINANCE_REPORTS.includes(reportId);
  return false;
}

module.exports = { ADMIN_FAMILY, ASSIGNABLE, MONEY_PREFIXES, SUPPORT_PREFIXES,
  FINANCE_REPORTS, isFamily, groupFor, can, canExport };
