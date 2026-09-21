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
module.exports = { dirs, kyc: make('kyc', /^(image\/(jpeg|png|webp)|application\/pdf)$/, 8), media: make('media', /^(image\/(jpeg|png|webp)|video\/(mp4|webm|quicktime))$/, 40) };
