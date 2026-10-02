const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const FileType = require('file-type');

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

// Map detected MIME types to the extension we will store on disk. The stored
// extension is always derived from the detected type, never from the client
// supplied originalname, so an attacker cannot get us to persist `.html`,
// `.svg`, etc. and have it served as active content.
const TYPE_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const storage = multer.diskStorage({
  destination: path.join(__dirname, '../../uploads'),
  filename: (_req, _file, cb) => {
    // Store with a neutral extension; the real extension is applied after the
    // magic-byte check in verifyUploadedFile().
    const unique = crypto.randomBytes(16).toString('hex');
    cb(null, `${unique}.upload`);
  },
});

function fileFilter(_req, file, cb) {
  // Cheap first-pass check on the declared type. This is NOT trusted for
  // security; the authoritative check is the magic-byte sniff below.
  if (ALLOWED_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      Object.assign(new Error('Only JPEG, PNG, and WebP images are allowed'), {
        code: 'INVALID_TYPE',
      })
    );
  }
}

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter,
});

/**
 * Verify the magic bytes of an uploaded file and rename it to the extension
 * that matches the detected type. Anything that is not a JPEG, PNG or WebP is
 * deleted from disk and rejected.
 *
 * @param {object} file multer file object (must have `path`)
 * @returns {Promise<object>} the file object with an updated `path`/`filename`
 */
async function verifyUploadedFile(file) {
  if (!file || !file.path) {
    throw Object.assign(new Error('No file uploaded'), { code: 'INVALID_TYPE' });
  }

  let detected;
  try {
    detected = await FileType.fromFile(file.path);
  } catch (err) {
    await safeUnlink(file.path);
    throw Object.assign(new Error('Could not read uploaded file'), {
      code: 'INVALID_TYPE',
    });
  }

  const ext = detected && TYPE_EXTENSIONS[detected.mime];
  if (!ext) {
    await safeUnlink(file.path);
    throw Object.assign(
      new Error('Only JPEG, PNG, and WebP images are allowed'),
      { code: 'INVALID_TYPE' }
    );
  }

  const newPath = `${file.path}${ext}`;
  try {
    await fs.promises.rename(file.path, newPath);
  } catch (err) {
    await safeUnlink(file.path);
    throw Object.assign(new Error('Could not store uploaded file'), {
      code: 'INVALID_TYPE',
    });
  }

  file.path = newPath;
  file.filename = path.basename(newPath);
  file.mimetype = detected.mime;
  return file;
}

async function safeUnlink(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch (_err) {
    // Best effort cleanup; ignore failures.
  }
}

module.exports = upload;
module.exports.verifyUploadedFile = verifyUploadedFile;
module.exports.ALLOWED_TYPES = ALLOWED_TYPES;
module.exports.TYPE_EXTENSIONS = TYPE_EXTENSIONS;
