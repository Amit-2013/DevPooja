-- 035_rebrand.sql
-- Rebrand in place: the platform name moves DaivikPooja -> DaivikPuja, and the
-- seeded demo coupon/social handles follow (DAIVIKPOOJA10 -> DAIVIKPUJA10,
-- facebook/instagram/youtube/linkedin.com/daivikpooja -> daivikpuja).
-- Data-only, idempotent, guarded so an existing DAIVIKPUJA10 row is never
-- collided with and rows already rebranded are skipped by the LIKE clauses.
-- Fresh installs run this BEFORE the seeders, so it matches nothing there —
-- the new seeders already write the new spelling.
-- Replay safety: UPDATE-only, and replayMigrationSeeds skips UPDATE statements.

UPDATE coupons SET code='DAIVIKPUJA10'
 WHERE code='DAIVIKPOOJA10'
   AND NOT EXISTS (SELECT 1 FROM coupons WHERE code='DAIVIKPUJA10');

UPDATE social_links SET url=replace(url,'daivikpooja','daivikpuja')
 WHERE url LIKE '%daivikpooja%';

UPDATE pandits SET bio=replace(bio,'DaivikPooja','DaivikPuja')
 WHERE bio LIKE '%DaivikPooja%';

UPDATE people SET intro=replace(intro,'DaivikPooja','DaivikPuja')
 WHERE intro LIKE '%DaivikPooja%';
UPDATE people SET bio=replace(bio,'DaivikPooja','DaivikPuja')
 WHERE bio LIKE '%DaivikPooja%';

UPDATE notifs SET message=replace(message,'DaivikPooja','DaivikPuja')
 WHERE message LIKE '%DaivikPooja%';

UPDATE campaigns SET message=replace(message,'DaivikPooja','DaivikPuja')
 WHERE message LIKE '%DaivikPooja%';
