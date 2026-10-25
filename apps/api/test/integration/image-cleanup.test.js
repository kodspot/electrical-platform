'use strict';

// IMAGE_CLEANUP (services/cleanup.js cleanupExpiredImages, daily): photos are kept for 30 days
// from when they were taken. It counted both ticket photos from the TICKET's creation, so a
// proof photo uploaded on day 29 of an old ticket was deleted the next night — before the
// supervisor or the resident could look at it. [BUG-0033]

process.env.NODE_ENV = 'test';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The local storage driver reads its root once, at load: set it before anything loads.
const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'image-cleanup-'));
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_DIR = STORAGE_DIR;

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { isDatabaseAvailable, cleanupTestOrgs, createTestOrg, createTestLocation, createTestTicket } = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');
const { uploadToR2 } = require('../../src/lib/r2');
const { cleanupExpiredImages } = require('../../src/services/cleanup');

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const fileOf = (url) => path.join(STORAGE_DIR, url.replace(/^\/images\//, ''));
const quiet = { info() {}, warn() {}, error() {} };

describe('BUG-0033: image retention counts from when each photo was taken', () => {
  let dbAvailable = false;
  let org, location;
  const createdOrgIds = [];
  const photo = () => uploadToR2(PNG, 'image/png', org.id);

  before(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    org = await createTestOrg();
    createdOrgIds.push(org.id);
    location = await createTestLocation(org.id);
  });

  after(async () => {
    if (!dbAvailable) return;
    await cleanupTestOrgs(createdOrgIds);
    fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
  });

  it('an old ticket\'s fresh proof photo is kept; its 40-day-old complaint photo goes; an old proof photo goes', async (t) => {
    if (!dbAvailable) return t.skip('No database available');
    const oldComplaint = await photo();
    const freshProof = await photo();
    const oldProof = await photo();
    const recentComplaint = await photo();

    const lateFix = await createTestTicket(org.id, location.id, { createdAt: daysAgo(40), imageUrl: oldComplaint, status: 'RESOLVED_PENDING_VERIFY', resolvedAt: daysAgo(2), resolvedImageUrl: freshProof });
    const longDone = await createTestTicket(org.id, location.id, { createdAt: daysAgo(45), status: 'CLOSED', resolvedAt: daysAgo(35), resolvedImageUrl: oldProof });
    const recent = await createTestTicket(org.id, location.id, { createdAt: daysAgo(5), imageUrl: recentComplaint });

    await cleanupExpiredImages(quiet);

    const a = await prisma.ticket.findUnique({ where: { id: lateFix.id } });
    assert.strictEqual(a.resolvedImageUrl, freshProof, 'the proof photo taken 2 days ago is kept');
    assert.ok(fs.existsSync(fileOf(freshProof)), 'and its file is still there');
    assert.strictEqual(a.imageUrl, null, 'the 40-day-old complaint photo is removed');
    assert.ok(!fs.existsSync(fileOf(oldComplaint)));

    const b = await prisma.ticket.findUnique({ where: { id: longDone.id } });
    assert.strictEqual(b.resolvedImageUrl, null, 'a proof photo taken 35 days ago is removed');
    assert.ok(!fs.existsSync(fileOf(oldProof)));

    const c = await prisma.ticket.findUnique({ where: { id: recent.id } });
    assert.strictEqual(c.imageUrl, recentComplaint, 'a 5-day-old complaint photo is kept');
  });
});
