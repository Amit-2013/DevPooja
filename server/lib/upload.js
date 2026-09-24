const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { rid, bad } = require('./util');

const root = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
const dirs = { kyc: path.join(root, 'kyc'), media: path.join(root, 'media') };
Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive: true }));

const make = (kind, allowed, maxMb) => multer({
  storage: multer.diskStorage({
    destination: (_r, _f, cb) => cb(null, dirs[kind]),
    filename: (_r, f, cb) => cb(null, rid(16) + path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8))
  }),
  limits: { fileSize: maxMb * 1024 * 1024, files: 8 },
  fileFilter: (_r, f, cb) => (allowed.test(f.mimetype) ? cb(null, true) : cb(bad('Unsupported file type')))
});

/* Magic-byte verification: the client-controlled Content-Type is only the first
   filter; the file's actual leading bytes must match its claimed type. Runs after
   multer has written the temp file; mismatches are deleted and rejected. */
const MAGIC = [
  { test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, type: 'image/jpeg' },
  { test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, type: 'image/png' },
  { test: (b) => b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP', type: 'image/webp' },
  { test: (b) => b.length > 5 && b.slice(0, 5).toString('ascii') === '%PDF-', type: 'application/pdf' },
  { test: (b) => b.length > 12 && b.slice(4, 8).toString('ascii') === 'ftyp', type: 'video/mp4' },
  { test: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3, type: 'video/webm' },
  { test: (b) => b.length > 12 && b.slice(4, 12).toString('ascii') === 'ftypqt  ', type: 'video/quicktime' }
];

function sniff(file) {
  const fd = fs.openSync(file.path, 'r');
  try {
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    const hit = MAGIC.find((m) => m.test(buf.subarray(0, n)));
    return hit ? hit.type : '';
  } finally { fs.closeSync(fd); }
}

/* Middleware factory: verify every uploaded file's real content type. */
const verifyMagic = () => (req, _res, next) => {
  const files = [...Object.values(req.files || {}).flat(), ...(req.file ? [req.file] : [])];
  for (const f of files) {
    const real = sniff(f);
    if (!real || real !== f.mimetype) {
      try { fs.unlinkSync(f.path); } catch (e) { /* already gone */ }
      return next(bad('File content does not match its type'));
    }
  }
  next();
};

module.exports = { dirs, kyc: make('kyc', /^(image\/(jpeg|png|webp)|application\/pdf)$/, 8), media: make('media', /^(image\/(jpeg|png|webp)|video\/(mp4|webm|quicktime))$/, 40), verifyMagic };
