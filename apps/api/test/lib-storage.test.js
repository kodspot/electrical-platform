'use strict';

// Regression tests for the storage abstraction (lib/r2.js) added in platform
// milestone M1 — the local filesystem driver that lets the app handle image
// uploads in development with no cloud credentials.
//
// Pure lib test: no database, no network, no R2. STORAGE_DRIVER and a temp
// LOCAL_STORAGE_DIR are set BEFORE requiring the module (LOCAL_STORAGE_DIR is
// read at module load; the driver is read at call time).

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const TMP_ROOT = path.join(os.tmpdir(), `kodspot-storage-test-${Date.now()}`);
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_DIR = TMP_ROOT;

const sharp = require('sharp');
const { uploadToR2, getFromR2, deleteFromR2 } = require('../src/lib/r2');

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

describe('lib/r2 — local storage driver (M1)', () => {
  let pngBuffer;

  before(async () => {
    pngBuffer = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 200, g: 40, b: 40 } } })
      .png().toBuffer();
  });

  after(async () => {
    await fsp.rm(TMP_ROOT, { recursive: true, force: true });
  });

  it('uploads an image to the local filesystem and returns the /images/ proxy path', async () => {
    const url = await uploadToR2(pngBuffer, 'image/png', 'org-abc');
    assert.match(url, /^\/images\/uploads\/org-abc\/\d+-[0-9a-f]+\.webp$/,
      'must return the same /images/uploads/<orgId>/... shape as the R2 driver');

    const key = url.slice('/images/'.length);
    assert.ok(fs.existsSync(path.join(TMP_ROOT, key)), 'the file must exist on disk after upload');
  });

  it('serves a stored image with the right Content-Type and a readable body', async () => {
    const url = await uploadToR2(pngBuffer, 'image/png', 'org-abc');
    const key = url.slice('/images/'.length);

    const res = await getFromR2(key);
    assert.strictEqual(res.ContentType, 'image/webp');
    const body = await streamToBuffer(res.Body);
    assert.ok(body.length > 0, 'served body must be non-empty');
  });

  it('deletes a stored image, and delete is idempotent (absent key is not an error)', async () => {
    const url = await uploadToR2(pngBuffer, 'image/png', 'org-abc');
    const key = url.slice('/images/'.length);
    assert.ok(fs.existsSync(path.join(TMP_ROOT, key)));

    await deleteFromR2(url);
    assert.ok(!fs.existsSync(path.join(TMP_ROOT, key)), 'file must be gone after delete');

    await assert.doesNotReject(deleteFromR2(url), 'deleting an already-absent image must not throw');
  });

  it('surfaces a missing image as NoSuchKey (so routes/images.js returns 404)', async () => {
    await assert.rejects(
      getFromR2('uploads/org-abc/does-not-exist.webp'),
      (err) => { assert.strictEqual(err.name, 'NoSuchKey'); return true; }
    );
  });

  it('re-encodes a large image to WebP within 800×800, keeping the aspect ratio (sharp 0.35)', async () => {
    const big = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 10, g: 120, b: 200 } } }).jpeg().toBuffer();
    const url = await uploadToR2(big, 'image/jpeg', 'org-abc');
    assert.match(url, /\.webp$/);
    const meta = await sharp(fs.readFileSync(path.join(TMP_ROOT, url.slice('/images/'.length)))).metadata();
    assert.strictEqual(meta.format, 'webp');
    assert.deepStrictEqual([meta.width, meta.height], [800, 600]);
  });

  it('never enlarges a small image', async () => {
    const url = await uploadToR2(pngBuffer, 'image/png', 'org-abc');
    const meta = await sharp(fs.readFileSync(path.join(TMP_ROOT, url.slice('/images/'.length)))).metadata();
    assert.deepStrictEqual([meta.format, meta.width, meta.height], ['webp', 10, 10]);
  });

  it('refuses a key that escapes the storage root (path traversal defense-in-depth)', async () => {
    await assert.rejects(
      getFromR2('uploads/../../../../etc/passwd'),
      (err) => { assert.strictEqual(err.name, 'InvalidKey'); return true; }
    );
  });
});

describe('validateImageBuffer — magic-byte check before any image reaches sharp', () => {
  const { validateImageBuffer } = require('../src/errors');
  const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0]);
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const webp = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1');
  const gif = Buffer.from('GIF89a', 'latin1');

  it('accepts JPEG, PNG and WebP whose bytes match the declared type', () => {
    assert.strictEqual(validateImageBuffer(jpeg, 'image/jpeg'), true);
    assert.strictEqual(validateImageBuffer(png, 'image/png'), true);
    assert.strictEqual(validateImageBuffer(webp, 'image/webp'), true);
  });

  it('rejects a declared type whose bytes do not match, an unsupported type, and an empty buffer', () => {
    assert.strictEqual(validateImageBuffer(gif, 'image/png'), false);
    assert.strictEqual(validateImageBuffer(png, 'image/jpeg'), false);
    assert.strictEqual(validateImageBuffer(gif, 'image/gif'), false);
    assert.strictEqual(validateImageBuffer(Buffer.from('<svg/>'), 'image/svg+xml'), false);
    assert.strictEqual(validateImageBuffer(Buffer.alloc(0), 'image/png'), false);
  });
});
