'use strict';

// Every jwt.verify accepted any HMAC algorithm (HS256/384/512) for the shared secret; the app
// only ever signs HS256. Not exploitable with one symmetric secret, but the allow-list is the
// expected defence in depth (OWASP ASVS V9; PRA-07 L3). Each verify site now pins HS256: a
// token signed any other way is refused like a forged one. [BUG-0046]

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const { getTestApp } = require('../helpers/build-app');
const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestUser, createTestWorker } = require('../helpers/db');

describe('BUG-0046: tokens signed with any algorithm but HS256 are refused at every verify site', () => {
  let dbAvailable = false;
  let app, org, admin, worker;
  const createdOrgIds = [];
  const sign = (payload, algorithm) => jwt.sign(payload, process.env.JWT_SECRET, { algorithm, expiresIn: '5m' });

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    app = await getTestApp();
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    admin = await createTestUser(org.id, { role: 'ADMIN' });
    worker = await createTestWorker(org.id);
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
  });

  const staff = (alg) => sign({ userId: admin.id, orgId: org.id, role: 'ADMIN' }, alg);
  const elec = (alg) => sign({ workerId: worker.id, orgId: org.id }, alg);

  for (const alg of ['HS384', 'HS512']) {
    it(`${alg}: staff API, electrician API, the image proxy and the electrician's live stream all answer 401`, async (t) => {
      if (!dbAvailable) return t.skip('No database available');
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${staff(alg)}` } });
      assert.strictEqual(me.statusCode, 401, `staff: ${me.statusCode}`);
      const workerMe = await app.inject({ method: 'GET', url: '/api/auth/worker-me', headers: { authorization: `Bearer ${elec(alg)}` } });
      assert.strictEqual(workerMe.statusCode, 401, `electrician: ${workerMe.statusCode}`);
      const image = await app.inject({ method: 'GET', url: `/api/images/uploads/${org.id}/x.png?token=${staff(alg)}` });
      assert.strictEqual(image.statusCode, 401, `image proxy: ${image.statusCode}`);
      const stream = await app.inject({ method: 'GET', url: `/api/notifications/worker-stream?token=${elec(alg)}` });
      assert.strictEqual(stream.statusCode, 401, `worker stream: ${stream.statusCode}`);
    });
  }

  it('HS256, as the app signs, still works', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${staff('HS256')}` } });
    assert.strictEqual(me.statusCode, 200, me.body);
    const workerMe = await app.inject({ method: 'GET', url: '/api/auth/worker-me', headers: { authorization: `Bearer ${elec('HS256')}` } });
    assert.strictEqual(workerMe.statusCode, 200, workerMe.body);
  });
});
