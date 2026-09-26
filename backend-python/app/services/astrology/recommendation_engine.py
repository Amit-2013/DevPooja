"""Recommendation engine — port of services/astrology/recommendationEngine.js:
maps detected conditions to pujas, havan kunds and samagri using the
condition_puja_rules table (admin-managed). Rules carry a weight and a priority
tier; the reason text is assembled from the rule row so admins can edit the
wording without touching code."""
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

# priority: primary | secondary | optional. Weight decides ordering inside a tier.
_RANK = {'primary': 0, 'secondary': 1, 'optional': 2}


async def recommendations_for(db: AsyncSession, detected_conditions: list[dict],
                              purpose: str | None = None) -> list[dict]:
    if not detected_conditions:
        return []
    codes = [d['code'] for d in detected_conditions]
    placeholders = ','.join(f':c{i}' for i in range(len(codes)))
    params = {f'c{i}': code for i, code in enumerate(codes)}

    sql = f"""
    SELECT r.condition_code AS code, r.weight, r.priority, r.reason, r.reason_hi AS reasonHi,
           p.id AS pujaId, p.name AS pujaName, p.icon, p.dur, p.price, p.hidden
    FROM condition_puja_rules r
    JOIN pujas p ON p.id = r.puja_id
    WHERE r.condition_code IN ({placeholders}) AND p.hidden = 0
    ORDER BY CASE r.priority WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1 ELSE 2 END, r.weight DESC, p.pop DESC
    """
    rows = (await db.execute(text(sql), params)).mappings().all()

    # de-duplicate: a puja mapped by two conditions appears once with both reasons
    by_puja: dict = {}
    for r in rows:
        if r['pujaId'] not in by_puja:
            by_puja[r['pujaId']] = {
                'pujaId': r['pujaId'], 'name': r['pujaName'], 'icon': r['icon'],
                'duration': r['dur'], 'price': r['price'],
                'priority': r['priority'] or 'secondary', 'weight': r['weight'],
                'reason': r['reason'] or '', 'reasonHi': r['reasonHi'] or '',
                'relatedDoshas': [],
            }
        rec = by_puja[r['pujaId']]
        if r['code'] not in rec['relatedDoshas']:
            rec['relatedDoshas'].append(r['code'])
        # keep the strongest priority a puja qualified for
        if _RANK.get(r['priority'] or 'secondary', 2) < _RANK.get(rec['priority'], 2):
            rec['priority'] = r['priority'] or 'secondary'

    out = list(by_puja.values())
    # purpose hint: if the customer declared a purpose, gently boost pujas tagged for
    # it. Ordering stays priority-first (primary -> secondary -> optional), weight inside.
    if purpose and purpose != 'General':
        import re
        m = re.split(r'[^a-z]+', purpose.lower(), maxsplit=1)
        tag = m[0] if m and m[0] else ''
        if tag:
            for rec in out:
                row = (await db.execute(text('SELECT tags FROM pujas WHERE id=:i'),
                                        {'i': rec['pujaId']})).mappings().first()
                if row and tag in (row['tags'] or '').lower():
                    rec['weight'] += 1

    out.sort(key=lambda rec: (_RANK.get(rec['priority'], 3), -rec['weight']))
    return out


# Havans (kunds) and samagri recommended for the pujas selected above.
async def havan_for(db: AsyncSession, puja_ids: list) -> list[dict]:
    if not puja_ids:
        return []
    placeholders = ','.join(f':p{i}' for i in range(len(puja_ids)))
    params = {f'p{i}': pid for i, pid in enumerate(puja_ids)}
    rows = (await db.execute(text(f"""
        SELECT k.id, k.name, k.material, k.size_in AS size, k.price, k.descr, pk.recommended, pk.puja_id AS pujaId
        FROM puja_kunds pk JOIN havan_kunds k ON k.id = pk.kund_id AND k.active = 1
        WHERE pk.puja_id IN ({placeholders})
        ORDER BY pk.recommended DESC, k.price
    """), params)).mappings().all()
    by_kund: dict = {}
    for r in rows:
        if r['id'] not in by_kund:
            by_kund[r['id']] = {'id': r['id'], 'name': r['name'], 'material': r['material'],
                                'size': r['size'], 'price': r['price'], 'descr': r['descr'],
                                'recommended': bool(r['recommended']), 'forPujas': []}
        by_kund[r['id']]['forPujas'].append(r['pujaId'])
    return list(by_kund.values())


async def samagri_for(db: AsyncSession, puja_ids: list) -> list[dict]:
    if not puja_ids:
        return []
    placeholders = ','.join(f':p{i}' for i in range(len(puja_ids)))
    params = {f'p{i}': pid for i, pid in enumerate(puja_ids)}
    rows = (await db.execute(text(f"""
        SELECT i.id, i.name, i.unit, ps.qty, ps.puja_id AS pujaId
        FROM puja_samagri ps JOIN samagri_items i ON i.id = ps.item_id AND i.active = 1
        WHERE ps.puja_id IN ({placeholders})
        ORDER BY i.name
    """), params)).mappings().all()
    by_item: dict = {}
    for r in rows:
        if r['id'] not in by_item:
            by_item[r['id']] = {'id': r['id'], 'name': r['name'], 'unit': r['unit'],
                                'qty': 0, 'forPujas': []}
        it = by_item[r['id']]
        it['qty'] = max(it['qty'], r['qty'])
        it['forPujas'].append(r['pujaId'])
    return list(by_item.values())
