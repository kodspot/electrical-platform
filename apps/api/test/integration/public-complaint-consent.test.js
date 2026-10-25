'use strict';

// The privacy policy says a guest who gives a name or phone "must explicitly check a consent
// checkbox". Only the page checked it, and it never told the server: a request with contact
// details and no consent was accepted, and nothing recorded that consent was given. The server
// now refuses contact details without `consent`, and the complaint's audit row records it.
// [BUG-0060]

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { getTestApp } = require('../helpers/build-app');
const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestLocation } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

function multipart(fields) {
  const boundary = '----consent' + crypto.randomUUID().replace(/-/g, '');
  const body = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('') + `--${boundary}--\r\n`;
  return { payload: Buffer.from(body), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('BUG-0060: a guest\'s contact details need their consent, checked and kept by the server', () => {
  let dbAvailable = false;
  let app, org;
  const createdOrgIds = [];
  let ip = 0;
  // A fresh location and address each time: complaints are limited per location and per IP.
  const post = async (fields) => {
    const location = await createTestLocation(org.id);
    const res = await app.inject({ method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': `10.88.60.${++ip}` }, payload: { locationId: location.id, issueType: 'LIGHT_NOT_WORKING', ...fields } });
    return { res, location };
  };
  const ticketsAt = (location) => prisma.ticket.count({ where: { locationId: location.id } });

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  it('a name or phone without consent is refused, and no ticket is made', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    for (const contact of [{ guestName: 'Meera' }, { guestPhone: '9876543210' }, { guestName: 'Meera', consent: false }]) {
      const { res, location } = await post(contact);
      assert.strictEqual(res.statusCode, 400, `${JSON.stringify(contact)}: ${res.body}`);
      assert.match(res.json().error, /consent/i);
      assert.strictEqual(await ticketsAt(location), 0);
    }
  });

  it('with consent the complaint is taken, and its audit row records the consent', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const { res } = await post({ guestName: 'Meera', guestPhone: '9876543210', consent: true });
    assert.strictEqual(res.statusCode, 200, res.body);
    const row = await prisma.auditLog.findFirst({ where: { action: 'ticket_public_create', entityId: res.json().ticket.id } });
    assert.strictEqual(row.newValue.consent, true);
  });

  it('the page\'s form post (multipart, consent=true) is taken; without consent it is refused', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const location = await createTestLocation(org.id);
    const ok = multipart({ locationId: location.id, issueType: 'LIGHT_NOT_WORKING', guestName: 'Meera', consent: 'true' });
    const okRes = await app.inject({ method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': `10.88.60.${++ip}`, ...ok.headers }, payload: ok.payload });
    assert.strictEqual(okRes.statusCode, 200, okRes.body);
    const other = await createTestLocation(org.id);
    const no = multipart({ locationId: other.id, issueType: 'LIGHT_NOT_WORKING', guestName: 'Meera' });
    const noRes = await app.inject({ method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': `10.88.60.${++ip}`, ...no.headers }, payload: no.payload });
    assert.strictEqual(noRes.statusCode, 400, noRes.body);
  });

  it('a complaint with no contact details needs no consent', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const { res } = await post({ description: 'Socket sparks' });
    assert.strictEqual(res.statusCode, 200, res.body);
  });

  it('the complaint page sends the consent with the contact details', () => {
    const page = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'public', 'scan.html'), 'utf8');
    assert.ok(page.includes("form.append('consent', 'true')"), 'scan.html sends consent');
  });
});
