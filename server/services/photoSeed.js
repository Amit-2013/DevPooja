/* Seed puja photos: copies the bundled, freely-licensed photos in
   shared/seed-photos/<pujaId>.jpg|png into the puja_media table (migration 009)
   as admin-uploaded, APPROVED + PUBLISHED primary photos.
   - Idempotent: a puja that already has ANY media row is skipped, so admin
     deletions and uploads are never overwritten on restart.
   - Files are copied into uploads/media under a server-generated name, so the
     media is served and downloaded exactly like any other photo.
   - Attribution lives in shared/seed-photos/CREDITS.md (shipped in the repo). */
'use strict';
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { rid } = require('../lib/util');

const SRC = path.join(__dirname, '..', '..', 'shared', 'seed-photos');
const MEDIA_DIR = require('../lib/upload').dirs.media;

function seedPujaPhotos() {
  if (!fs.existsSync(SRC)) return { seeded: 0, skipped: 0 };
  const files = fs.readdirSync(SRC).filter((f) => /\.(jpe?g|png)$/i.test(f));
  let seeded = 0, skipped = 0;
  for (const f of files) {
    const pujaId = f.replace(/\.(jpe?g|png)$/i, '');
    if (!db.prepare('SELECT 1 FROM pujas WHERE id=?').get(pujaId)) continue;       // unknown puja id
    if (db.prepare('SELECT 1 FROM puja_media WHERE puja_id=? LIMIT 1').get(pujaId)) { skipped++; continue; }
    const buf = fs.readFileSync(path.join(SRC, f));
    const filename = 'seed-' + pujaId + '-' + rid(6) + (/[.]png$/i.test(f) ? '.png' : '.jpg');
    fs.writeFileSync(path.join(MEDIA_DIR, filename), buf);
    const id = 'pm' + rid(5);
    db.prepare(`INSERT INTO puja_media(id,puja_id,uploaded_by,orig_name,filename,mime,size,status,is_primary,is_published,display_order,created_at)
                VALUES(?,?,?,?,?,?,?,'APPROVED',1,1,0,?)`)
      .run(id, pujaId, 'admin1', f, filename, /[.]png$/i.test(f) ? 'image/png' : 'image/jpeg', buf.length, Date.now());
    seeded++;
  }
  return { seeded, skipped };
}

module.exports = { seedPujaPhotos };
