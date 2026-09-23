#!/usr/bin/env node
/* Verifies database connectivity and required schema, including the Kundali module.
   Exit code 1 on any failure, so it can gate CI or deploys.
   Usage: node server/tools/db-health.js */
'use strict';
require('dotenv').config();
const { db } = require('../db');

let failures = 0;
const check = (label, ok, hint) => {
  console.log((ok ? '  ok  ' : 'FAIL  ') + label + (ok ? '' : '  -> ' + hint));
  if (!ok) failures++;
};

const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
const cols = (t) => { try { return new Set(db.prepare('PRAGMA table_info(' + JSON.stringify(t) + ')').all().map((c) => c.name)); } catch (e) { return new Set(); } };

console.log('DB connectivity: ' + (process.env.DB_PATH || 'data/daivikpooja.db') + '\n');

console.log('Core application tables:');
for (const t of ['users','pandits','pujas','kits','prasad','temples','festivals','bookings','orders','notifs','tickets','campaigns','leads','payouts','coupons','banners','settings','otps']) {
  check(t, tables.has(t), 'core table missing — was the base schema created?');
}

console.log('\nCore columns the app reads and writes:');
check('bookings.q (price snapshot)', tables.has('bookings') && cols('bookings').has('q'), 'bookings.q missing');
check('bookings.pay', tables.has('bookings') && cols('bookings').has('pay'), 'bookings.pay missing');
check('bookings.review', tables.has('bookings') && cols('bookings').has('review'), 'bookings.review missing');
check('bookings double-booking index',
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='idx_pandit_slot'").get().c === 1,
  'the partial unique index idx_pandit_slot is what makes double-booking impossible');
check('users.pts', tables.has('users') && cols('users').has('pts'), 'users.pts missing (reward points)');
check('users.plus', tables.has('users') && cols('users').has('plus'), 'users.plus missing (membership)');

console.log('\nRelational extensions (migration 001):');
for (const t of ['payments','reviews','audit_logs','booking_status_history','order_items','cart_items','ticket_messages','temple_pujas']) {
  check(t, tables.has(t), 'run: node server/migrate.js');
}

console.log('\nKundali module (migration 002):');
for (const t of ['kundali_profiles','kundali_recommendations','havan_kunds','puja_kunds','samagri_items','puja_samagri','kundali_conditions','condition_puja_rules','kundali_analysis','kundali_activity']) {
  check(t, tables.has(t), 'run: node server/migrate.js');
}
check('puja_kunds.recommended column (spec uses recommended, NOT priority)',
  tables.has('puja_kunds') && cols('puja_kunds').has('recommended') && !cols('puja_kunds').has('priority'),
  'puja_kunds must have recommended and must not have priority');

console.log('\nData sanity:');
check('pujas seeded', tables.has('pujas') && db.prepare('SELECT COUNT(*) c FROM pujas').get().c > 0, 'catalogue is empty — run: npm run seed');
check('no booking without a price snapshot', tables.has('bookings') &&
  db.prepare("SELECT COUNT(*) c FROM bookings WHERE q IS NULL OR q=''").get().c === 0, 'rows exist with empty q');

console.log(failures ? '\n' + failures + ' check(s) failed.' : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
