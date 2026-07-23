'use strict';

const { prisma } = require('../lib/prisma');
const { deleteFromR2 } = require('../lib/r2');
const { runExclusive, LOCK_KEYS } = require('../lib/scheduler-lock');

const RETENTION_DAYS = 30;

/**
 * Deletes images older than RETENTION_DAYS from R2 storage and nulls out the URLs in the DB.
 * Covers electrical inspection images, ticket photos, and resolution proof photos.
 * Metadata is kept forever — only image binaries and URLs are removed.
 */
async function cleanupExpiredImages(logger) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  let deleted = 0;
  let failed = 0;

  // 1) Electrical inspection images
  const expiredImages = await prisma.electricalImage.findMany({
    where: {
      createdAt: { lt: cutoff },
      imageUrl: { not: '', startsWith: '/images/' }
    },
    select: { id: true, imageUrl: true }
  });

  for (const img of expiredImages) {
    try {
      await deleteFromR2(img.imageUrl);
      await prisma.electricalImage.update({
        where: { id: img.id },
        data: { imageUrl: '' }
      });
      deleted++;
    } catch (err) {
      failed++;
      logger.error(`[cleanup] Failed to delete inspection image ${img.id}: ${err.message}`);
    }
  }

  // 2) Ticket photos (initial complaint image + resolved proof image)
  const expiredTickets = await prisma.ticket.findMany({
    where: {
      createdAt: { lt: cutoff },
      OR: [
        { imageUrl: { not: null, startsWith: '/images/' } },
        { resolvedImageUrl: { not: null, startsWith: '/images/' } }
      ]
    },
    select: { id: true, imageUrl: true, resolvedImageUrl: true }
  });

  for (const t of expiredTickets) {
    const updates = {};
    if (t.imageUrl && t.imageUrl.startsWith('/images/')) {
      try { await deleteFromR2(t.imageUrl); updates.imageUrl = null; deleted++; }
      catch (err) { failed++; logger.error(`[cleanup] Failed ticket img ${t.id}: ${err.message}`); }
    }
    if (t.resolvedImageUrl && t.resolvedImageUrl.startsWith('/images/')) {
      try { await deleteFromR2(t.resolvedImageUrl); updates.resolvedImageUrl = null; deleted++; }
      catch (err) { failed++; logger.error(`[cleanup] Failed ticket resolve img ${t.id}: ${err.message}`); }
    }
    if (Object.keys(updates).length > 0) {
      try { await prisma.ticket.update({ where: { id: t.id }, data: updates }); }
      catch (err) { logger.error(`[cleanup] Failed ticket update ${t.id}: ${err.message}`); }
    }
  }

  if (deleted === 0 && failed === 0) {
    logger.info(`[cleanup] No expired images found (retention: ${RETENTION_DAYS} days)`);
  } else {
    logger.info(`[cleanup] Image retention completed: ${deleted} deleted, ${failed} failed (retention: ${RETENTION_DAYS} days)`);
  }
  return deleted;
}

/**
 * DPDP Act compliance: Anonymize guest complaint PII after 180 days.
 * Nulls out guestName and guestPhone on public tickets older than cutoff.
 */
const GUEST_RETENTION_DAYS = 180;

async function anonymizeGuestData(logger) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - GUEST_RETENTION_DAYS);

  const result = await prisma.ticket.updateMany({
    where: {
      source: 'PUBLIC',
      createdAt: { lt: cutoff },
      OR: [
        { guestName: { not: null } },
        { guestPhone: { not: null } }
      ]
    },
    data: {
      guestName: null,
      guestPhone: null
    }
  });

  if (result.count > 0) {
    logger.info(`[cleanup] Anonymized PII on ${result.count} guest complaints older than ${GUEST_RETENTION_DAYS} days`);
  }
  return result.count;
}

/**
 * Seed default inspection template for organizations that have none.
 * Runs once at startup — idempotent.
 */
const DEFAULT_TEMPLATE_ITEMS = [
  { label: 'Lighting',         checkKey: 'LIGHTING',        responseType: 'STATUS', sortOrder: 0 },
  { label: 'Fan',              checkKey: 'FAN',             responseType: 'STATUS', sortOrder: 1 },
  { label: 'AC',               checkKey: 'AC',              responseType: 'STATUS', sortOrder: 2 },
  { label: 'Switch Board',     checkKey: 'SWITCH_BOARD',    responseType: 'STATUS', sortOrder: 3 },
  { label: 'Socket',           checkKey: 'SOCKET',          responseType: 'STATUS', sortOrder: 4 },
  { label: 'Wiring',           checkKey: 'WIRING',          responseType: 'STATUS', sortOrder: 5 },
  { label: 'MCB Panel',        checkKey: 'MCB_PANEL',       responseType: 'STATUS', sortOrder: 6 },
  { label: 'Earthing',         checkKey: 'EARTHING',        responseType: 'STATUS', sortOrder: 7 },
  { label: 'Emergency Light',  checkKey: 'EMERGENCY_LIGHT', responseType: 'STATUS', sortOrder: 8 }
];

async function seedDefaultTemplates(logger) {
  const orgs = await prisma.organization.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, name: true, _count: { select: { inspectionTemplates: true } } }
  });

  let seeded = 0;
  for (const org of orgs) {
    if (org._count.inspectionTemplates > 0) continue;
    try {
      await prisma.inspectionTemplate.create({
        data: {
          orgId: org.id,
          name: 'Standard Electrical Inspection',
          description: 'Default 9-item electrical safety checklist',
          isDefault: true,
          isActive: true,
          items: { create: DEFAULT_TEMPLATE_ITEMS }
        }
      });
      seeded++;
      logger.info(`[seed] Created default template for org "${org.name}"`);
    } catch (err) {
      logger.error(`[seed] Failed to seed template for org "${org.name}": ${err.message}`);
    }
  }
  if (seeded > 0) logger.info(`[seed] Seeded default templates for ${seeded} organization(s)`);
  return seeded;
}

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Wraps each job with an advisory-lock gate (src/lib/scheduler-lock.js) so that if
// more than one instance ever runs this scheduler concurrently, only one of them
// actually executes a given tick — the others skip it and pick it up next interval.
// A skipped tick is not lost: every job here only acts on rows past an age cutoff,
// so the next scheduled run naturally catches whatever the skipped one would have.
function runJob(lockKey, jobFn, logger, jobLabel) {
  return runExclusive(prisma, lockKey, jobFn, logger).catch(err => {
    logger.error(`[cleanup] ${jobLabel} failed:`, err.message);
  });
}

function startCleanupScheduler(logger) {
  // Run once on startup (with a short delay to not block boot)
  const startupTimeout = setTimeout(() => {
    runJob(LOCK_KEYS.IMAGE_CLEANUP, () => cleanupExpiredImages(logger), logger, 'Startup cleanup');
    runJob(LOCK_KEYS.GUEST_ANONYMIZATION, () => anonymizeGuestData(logger), logger, 'Startup guest anonymization');
    runJob(LOCK_KEYS.TEMPLATE_SEEDING, () => seedDefaultTemplates(logger), logger, 'Startup template seeding');
  }, 30000); // 30 seconds after boot

  // Then run every 24 hours
  const dailyInterval = setInterval(() => {
    runJob(LOCK_KEYS.IMAGE_CLEANUP, () => cleanupExpiredImages(logger), logger, 'Scheduled cleanup');
    runJob(LOCK_KEYS.GUEST_ANONYMIZATION, () => anonymizeGuestData(logger), logger, 'Scheduled guest anonymization');
    // Clean up old alerts/insights (90-day retention)
    const { cleanupOldAlerts } = require('./automation');
    runJob(LOCK_KEYS.ALERT_INSIGHT_CLEANUP, () => cleanupOldAlerts(logger), logger, 'Alert cleanup');
  }, INTERVAL_MS);

  // Returned so index.js can clear every timer on graceful shutdown, instead of
  // leaving them pending when the process exits.
  return { startupTimeout, dailyInterval };
}

module.exports = { cleanupExpiredImages, startCleanupScheduler };
