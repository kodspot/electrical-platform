'use strict';

/**
 * Object storage abstraction for images (inspection photos, ticket proof photos,
 * public-complaint images, asset images).
 *
 * Two drivers, selected by STORAGE_DRIVER at call time:
 *   - 'r2'    (default) — Cloudflare R2 via the S3 API. The production driver.
 *   - 'local'           — the local filesystem (data/uploads/). For development so
 *                         the app boots and handles image uploads WITHOUT any cloud
 *                         credentials. Never used in production.
 *
 * The module keeps its historical name and export surface (uploadToR2 / getFromR2 /
 * deleteFromR2) so none of its ~8 callers change — a rename would be pure blast radius.
 * Sharp image compression and the returned "/images/<key>" path are identical across
 * drivers, so callers, the DB-stored path, and the /images/ proxy behave the same either
 * way. Production behavior with STORAGE_DRIVER unset (or 'r2') is byte-for-byte unchanged.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');

let logger = { warn: console.warn, error: console.error, info: console.log };
function setLogger(l) { logger = l; }

// Read the driver at call time (not module load) so it is test-toggleable and so a
// local-dev boot with no R2 env never constructs the S3 client.
function currentDriver() {
  return (process.env.STORAGE_DRIVER || 'r2').toLowerCase();
}

// ── R2 driver (production) ──
// Lazily constructed: with STORAGE_DRIVER=local and no R2_* env, this is never called.
let _r2Client = null;
function getR2Client() {
  if (!_r2Client) {
    _r2Client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      },
      maxAttempts: 3
    });
  }
  return _r2Client;
}

async function r2Put(key, buffer, mimetype) {
  await getR2Client().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mimetype,
    CacheControl: 'public, max-age=31536000, immutable'
  }));
}

async function r2Get(key) {
  const res = await getR2Client().send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key
  }));
  return { ContentType: res.ContentType, Body: res.Body };
}

async function r2Delete(key) {
  await getR2Client().send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key
  }));
}

// ── Local filesystem driver (development) ──
// Storage root defaults to the repo/app-root data/uploads/ (git-ignored). Never mounted
// in the production container, so it is inert there even if accidentally selected.
const LOCAL_ROOT = process.env.LOCAL_STORAGE_DIR || path.join(__dirname, '..', '..', '..', '..', 'data', 'uploads');

// Resolve a storage key to an absolute path, refusing anything that escapes LOCAL_ROOT
// (defense in depth — routes/images.js already blocks '..' and enforces the uploads/
// prefix, but the driver must not trust that).
function localPathForKey(key) {
  const resolved = path.resolve(LOCAL_ROOT, key);
  const rootWithSep = path.resolve(LOCAL_ROOT) + path.sep;
  if (resolved !== path.resolve(LOCAL_ROOT) && !resolved.startsWith(rootWithSep)) {
    const err = new Error('Invalid storage key');
    err.name = 'InvalidKey';
    throw err;
  }
  return resolved;
}

const EXT_CONTENT_TYPE = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

async function localPut(key, buffer) {
  const dest = localPathForKey(key);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, buffer);
}

async function localGet(key) {
  const src = localPathForKey(key);
  try {
    await fsp.access(src);
  } catch {
    // Match the shape routes/images.js already handles as a 404.
    const err = new Error('Not found');
    err.name = 'NoSuchKey';
    throw err;
  }
  const ContentType = EXT_CONTENT_TYPE[path.extname(src).toLowerCase()] || 'application/octet-stream';
  return { ContentType, Body: fs.createReadStream(src) };
}

async function localDelete(key) {
  const target = localPathForKey(key);
  try {
    await fsp.unlink(target);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // absent is fine — same as R2's idempotent delete
  }
}

// ── Public API (driver-agnostic) ──

async function uploadToR2(buffer, mimetype, orgId) {
  // Compress and convert to WebP for optimal delivery — shared across drivers.
  try {
    buffer = await sharp(buffer)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    mimetype = 'image/webp';
  } catch (e) {
    logger.warn('sharp compression failed, uploading original:', e.message);
  }

  const ext = mimetype === 'image/png' ? '.png' :
    mimetype === 'image/webp' ? '.webp' : '.jpg';
  const key = `uploads/${orgId}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;

  if (currentDriver() === 'local') {
    await localPut(key, buffer);
  } else {
    await r2Put(key, buffer, mimetype);
  }

  // Return API-relative path — images are served privately through the /images/ proxy.
  return `/images/${key}`;
}

async function getFromR2(key) {
  return currentDriver() === 'local' ? localGet(key) : r2Get(key);
}

async function deleteFromR2(imageUrl) {
  if (!imageUrl) return;
  // Extract the storage key from the stored path: /images/uploads/orgId/file.webp
  let key = imageUrl;
  if (key.startsWith('/images/')) key = key.slice(8);
  if (!key || !key.startsWith('uploads/')) return;

  if (currentDriver() === 'local') {
    await localDelete(key);
  } else {
    await r2Delete(key);
  }
}

module.exports = { uploadToR2, getFromR2, deleteFromR2, setLogger };
