/* Recommendation engine: maps detected conditions to pujas, havan kunds and samagri
   using the condition_puja_rules table (admin-managed). Rules carry a weight and a
   priority tier; the reason text is assembled from the rule row so admins can edit
   the wording without touching code. */
'use strict';
const { db } = require('../../db');

/* priority: primary | secondary | optional. Weight decides ordering inside a tier. */
function recommendationsFor(detectedConditions, { purpose } = {}) {
  if (!detectedConditions.length) return [];
  const codes = detectedConditions.map((d) => d.code);

  const rows = db.prepare(`
    SELECT r.condition_code AS code, r.weight, r.priority, r.reason, r.reason_hi AS reasonHi,
           p.id AS pujaId, p.name AS pujaName, p.icon, p.dur, p.price, p.hidden
    FROM condition_puja_rules r
    JOIN pujas p ON p.id = r.puja_id
    WHERE r.condition_code IN (${codes.map(() => '?').join(',')}) AND p.hidden = 0
    ORDER BY CASE r.priority WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1 ELSE 2 END, r.weight DESC, p.pop DESC
  `).all(...codes);

  /* de-duplicate: a puja mapped by two conditions appears once with both reasons */
  const byPuja = new Map();
  for (const r of rows) {
    if (!byPuja.has(r.pujaId)) {
      byPuja.set(r.pujaId, {
        pujaId: r.pujaId, name: r.pujaName, icon: r.icon, duration: r.dur, price: r.price,
        priority: r.priority || 'secondary', weight: r.weight,
        reason: r.reason || '', reasonHi: r.reasonHi || '', relatedDoshas: []
      });
    }
    const rec = byPuja.get(r.pujaId);
    if (!rec.relatedDoshas.includes(r.code)) rec.relatedDoshas.push(r.code);
    /* keep the strongest priority a puja qualified for */
    const rank = { primary: 0, secondary: 1, optional: 2 };
    if ((rank[r.priority || 'secondary'] ?? 2) < (rank[rec.priority] ?? 2)) rec.priority = r.priority || 'secondary';
  }

  const out = [...byPuja.values()];
  /* purpose hint: if the customer declared a purpose, gently boost pujas tagged for it.
     Ordering stays priority-first (primary -> secondary -> optional), weight inside. */
  if (purpose && purpose !== 'General') {
    const tag = purpose.toLowerCase().split(/[^a-z]+/)[0];
    for (const rec of out) {
      const puja = db.prepare('SELECT tags FROM pujas WHERE id=?').get(rec.pujaId);
      if (puja && (puja.tags || '').toLowerCase().includes(tag)) rec.weight += 1;
    }
  }
  const rank = { primary: 0, secondary: 1, optional: 2 };
  out.sort((a, b) => (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3) || b.weight - a.weight);
  return out;
}

/* Havans (kunds) and samagri recommended for the pujas selected above. */
function havanFor(pujaIds) {
  if (!pujaIds.length) return [];
  const rows = db.prepare(`
    SELECT k.id, k.name, k.material, k.size_in AS size, k.price, k.descr, pk.recommended, pk.puja_id AS pujaId
    FROM puja_kunds pk JOIN havan_kunds k ON k.id = pk.kund_id AND k.active = 1
    WHERE pk.puja_id IN (${pujaIds.map(() => '?').join(',')})
    ORDER BY pk.recommended DESC, k.price
  `).all(...pujaIds);
  const byKund = new Map();
  for (const r of rows) {
    if (!byKund.has(r.id)) byKund.set(r.id, { id: r.id, name: r.name, material: r.material, size: r.size, price: r.price, descr: r.descr, recommended: !!r.recommended, forPujas: [] });
    byKund.get(r.id).forPujas.push(r.pujaId);
  }
  return [...byKund.values()];
}

function samagriFor(pujaIds) {
  if (!pujaIds.length) return [];
  const rows = db.prepare(`
    SELECT i.id, i.name, i.unit, ps.qty, ps.puja_id AS pujaId
    FROM puja_samagri ps JOIN samagri_items i ON i.id = ps.item_id AND i.active = 1
    WHERE ps.puja_id IN (${pujaIds.map(() => '?').join(',')})
    ORDER BY i.name
  `).all(...pujaIds);
  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.id)) byItem.set(r.id, { id: r.id, name: r.name, unit: r.unit, qty: 0, forPujas: [] });
    const it = byItem.get(r.id);
    it.qty = Math.max(it.qty, r.qty);
    it.forPujas.push(r.pujaId);
  }
  return [...byItem.values()];
}

module.exports = { recommendationsFor, havanFor, samagriFor };
