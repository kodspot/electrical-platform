'use strict';

// Image upload validation through a real route (POST /api/public/complaint, multipart),
// re-checked with the upgraded image stack (PR A: sharp 0.35, @fastify/busboy 3.2.3).
// Every rejection happens before the image reaches sharp or storage and before any
// database lookup: wrong declared type, magic bytes that don't match the declared type,
// and a file over the 5 MB multipart limit.

process.env.NODE_ENV = 'test';
process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || 'a'.repeat(64);

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { getTestApp } = require('../helpers/build-app');

const BOUNDARY = `----upload-test-${crypto.randomBytes(6).toString('hex')}`;
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);

function multipart(fields, file) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="image"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.body, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(parts);
}

describe('image upload validation — public complaint route', () => {
  let app;
  let ip = 0;
  before(async () => { app = await getTestApp(); });

  const post = (file) => app.inject({
    method: 'POST',
    url: '/api/public/complaint',
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, 'x-forwarded-for': `10.91.0.${++ip}` },
    payload: multipart({ locationId: crypto.randomUUID(), issueType: 'LIGHT_NOT_WORKING', consent: 'true' }, file)
  });

  it('a non-image type is rejected with 400 before it is read', async () => {
    const res = await post({ name: 'x.svg', type: 'image/svg+xml', body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.json().error, /Invalid image type/);
  });

  it('bytes that do not match the declared type (a GIF sent as PNG) are rejected with 400', async () => {
    const res = await post({ name: 'x.png', type: 'image/png', body: Buffer.from('GIF89a........', 'latin1') });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.json().error, 'Invalid image file');
  });

  it('a file over the 5 MB limit is refused with 413, not a 500', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 16, 0x41)]);
    const res = await post({ name: 'big.png', type: 'image/png', body: big });
    assert.strictEqual(res.statusCode, 413, res.body.slice(0, 200));
  });
});
