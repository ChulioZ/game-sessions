'use strict';

/* Image upload (multer) for game cover images, stored under data/uploads/.
 *
 * Files are buffered in memory rather than written straight to disk, so the
 * real content can be verified before anything is persisted: both the client
 * `mimetype` and the `originalname` are attacker-controlled, so we sniff the
 * leading magic bytes, accept only known image types, and derive the stored
 * extension from the *detected* type — never from the client filename. Only
 * `saveUploadedImage` writes to disk, and only for content that sniffs as a
 * supported image (issue #133). */

const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR, id } = require('./store');

// Sniff the leading bytes of a buffer and return the extension for the image
// type we store (`.jpg`/`.png`/`.gif`/`.webp`), or null when the content isn't
// one of them. The client mimetype/filename are ignored entirely.
function sniffImageExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return '.png';
  // GIF: "GIF87a" or "GIF89a"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return '.gif';
  // WEBP: "RIFF" <4-byte size> "WEBP"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return '.webp';
  return null;
}

// Verify an uploaded file's real content and persist it under data/uploads/
// with an extension derived from the detected type. Returns the public
// '/uploads/<id><ext>' path, or null when there is no file or its content
// isn't a supported image (the caller rejects that with 400). Nothing is
// written to disk for a rejected file.
function saveUploadedImage(file) {
  if (!file || !file.buffer) return null;
  const ext = sniffImageExt(file.buffer);
  if (!ext) return null;
  const filename = id() + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), file.buffer);
  return '/uploads/' + filename;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB is plenty for a cover
  // Cheap first-pass reject on the (spoofable) mimetype; the real gate is the
  // magic-byte sniff in saveUploadedImage before anything is written to disk.
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

module.exports = { upload, saveUploadedImage, sniffImageExt };
