#!/usr/bin/env node
/* Prints tables, columns, indexes, foreign keys and row counts.
   Usage: node server/tools/inspect-db.js [table]  (no table = summary) */
'use strict';
require('dotenv').config();
const { db } = require('../db');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const filter = process.argv[2];
const list = filter ? tables.filter((t) => t.includes(filter)) : tables;

if (filter && !list.length) {
  console.error('No table matching "' + filter + '". Tables: ' + tables.join(', '));
  process.exit(1);
}

console.log('Database: ' + (process.env.DB_PATH || 'data/daivikpooja.db') + '\n');
for (const t of list) {
  const cols = db.prepare('PRAGMA table_info(' + JSON.stringify(t) + ')').all();
  const pk = cols.filter((c) => c.pk).map((c) => c.name);
  const fks = db.prepare('PRAGMA foreign_key_list(' + JSON.stringify(t) + ')').all();
  const idx = db.prepare('PRAGMA index_list(' + JSON.stringify(t) + ')').all().map((i) => i.name);
  let rows = '?';
  try { rows = String(db.prepare('SELECT COUNT(*) c FROM ' + JSON.stringify(t)).get().c); } catch (e) { /* views etc. */ }
  console.log('== ' + t + '  (' + rows + ' rows)');
  console.log('   columns: ' + cols.map((c) => c.name + (c.pk ? '*' : '') + (c.notnull ? '!' : '')).join(', '));
  if (pk.length) console.log('   primary key: ' + pk.join(', '));
  if (fks.length) console.log('   foreign keys: ' + fks.map((f) => f.table + '(' + f.from + '->' + f.to + ')').join(', '));
  if (idx.length) console.log('   indexes: ' + idx.join(', '));
  console.log('');
}
