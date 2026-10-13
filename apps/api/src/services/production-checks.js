'use strict';

/**
 * Live, READ-ONLY production checks for the super-admin Quality page
 * (POST /api/superadmin/qa/checks). [WP-Q, ADR 0005]
 *
 * Each check returns { name, status: PASS|WARN|FAIL|SKIPPED, detail } and is capped at 5 s.
 * Nothing here writes, sends or deletes: R2 is HeadBucket + ListObjectsV2 (object metadata
 * only, no content read), SMTP is transporter.verify() (no email sent), GitHub is one GET.
 * Details are built from counts, ages, booleans and error NAMES only — never a host,
 * bucket name, URL, header value or secret.
 *
 * Dependencies are injectable so tests can stub R2/SMTP/GitHub without any network.
 */

const fs = require('fs');
const path = require('path');
const { HeadBucketCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const CHECK_TIMEOUT_MS = 5000;
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'prisma', 'migrations');
const BACKUP_PREFIX = 'db-backups/';

function defaultDeps() {
  const { prisma } = require('../lib/prisma');
  const { getR2Client, currentDriver } = require('../lib/r2');
  const { verifyTransport } = require('../lib/email');
  const { checkDispatchToken } = require('../lib/github');
  const { getConnectionStats } = require('./sse');
  return {
    prisma,
    migrationsDir: MIGRATIONS_DIR,
    storageDriver: currentDriver,
    r2Client: getR2Client,
    verifySmtp: verifyTransport,
    checkDispatchToken,
    sseStats: getConnectionStats,
    env: process.env,
    now: () => Date.now(),
    uptimeSeconds: () => process.uptime()
  };
}

const result = (name, status, detail) => ({ name, status, detail });
const has = (env, key) => typeof env[key] === 'string' && env[key].trim() !== '';

async function checkDatabase(d) {
  await d.prisma.$queryRaw`SELECT 1`;
  const rows = await d.prisma.$queryRaw`
    SELECT migration_name FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  const applied = new Set(rows.map((r) => r.migration_name));
  const shipped = fs.readdirSync(d.migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(d.migrationsDir, e.name, 'migration.sql')))
    .map((e) => e.name);
  const missing = shipped.filter((m) => !applied.has(m));
  const unknown = [...applied].filter((m) => !shipped.includes(m));
  if (missing.length) return result('database', 'FAIL', `reachable; ${missing.length} shipped migration(s) not applied`);
  if (unknown.length) return result('database', 'WARN', `reachable; ${shipped.length} shipped migrations applied, plus ${unknown.length} applied migration(s) not in this build`);
  return result('database', 'PASS', `reachable; all ${shipped.length} shipped migrations applied`);
}

async function checkOffsiteBackups(d) {
  if (d.storageDriver() === 'local') return result('offsite-backups', 'SKIPPED', 'local storage driver: no R2 in use');
  const Bucket = d.env.R2_BACKUP_BUCKET_NAME || d.env.R2_BUCKET_NAME;
  if (!Bucket) return result('offsite-backups', 'FAIL', 'no backup bucket configured');
  const client = d.r2Client();
  try {
    await client.send(new HeadBucketCommand({ Bucket }));
    let newest = null;
    let count = 0;
    let ContinuationToken;
    for (let page = 0; page < 5; page++) {
      const res = await client.send(new ListObjectsV2Command({ Bucket, Prefix: BACKUP_PREFIX, ContinuationToken }));
      for (const o of res.Contents || []) {
        count++;
        const t = new Date(o.LastModified).getTime();
        if (!newest || t > newest) newest = t;
      }
      if (!res.IsTruncated) break;
      ContinuationToken = res.NextContinuationToken;
    }
    if (!newest) return result('offsite-backups', 'FAIL', 'bucket reachable but no offsite backups found');
    const hours = Math.round(((d.now() - newest) / 3_600_000) * 10) / 10;
    const status = hours <= 26 ? 'PASS' : hours <= 48 ? 'WARN' : 'FAIL';
    return result('offsite-backups', status, `newest offsite backup is ${hours} h old (${count} object(s) listed)`);
  } catch (err) {
    const http = err && err.$metadata && err.$metadata.httpStatusCode;
    return result('offsite-backups', 'FAIL', `R2 request failed (${(err && err.name) || 'Error'}${http ? `, http ${http}` : ''})`);
  }
}

async function checkSmtp(d) {
  const v = await d.verifySmtp();
  if (!v.configured) return result('email', 'WARN', 'SMTP not configured: password-reset and notification emails will not send');
  if (v.ok) return result('email', 'PASS', 'SMTP connection and credentials verified (no email sent)');
  return result('email', 'FAIL', `SMTP verify failed (${v.code})`);
}

function checkConfiguration(d) {
  const e = d.env;
  const alerting = (has(e, 'ALERT_TELEGRAM_BOT_TOKEN') && has(e, 'ALERT_TELEGRAM_CHAT_ID')) || has(e, 'ALERT_WEBHOOK_URL');
  return [
    result('config: error alerting', alerting ? 'PASS' : 'WARN', alerting ? 'configured' : 'not configured: a 5xx alerts no one'),
    result('config: IP hash pepper', has(e, 'IP_HASH_PEPPER') ? 'PASS' : 'WARN', has(e, 'IP_HASH_PEPPER') ? 'configured' : 'not configured: complaint IP hashing is unpeppered'),
    result('config: QA ingest token', has(e, 'QA_INGEST_TOKEN') ? 'PASS' : 'WARN', has(e, 'QA_INGEST_TOKEN') ? 'configured' : 'not configured: CI results cannot reach this page'),
    result('config: dispatch token', has(e, 'GH_ACTIONS_DISPATCH_TOKEN') ? 'PASS' : 'WARN', has(e, 'GH_ACTIONS_DISPATCH_TOKEN') ? 'configured' : 'not configured: CI status is read unauthenticated; dispatch unavailable')
  ];
}

function checkBuild(d) {
  const sha = has(d.env, 'GIT_SHA') ? d.env.GIT_SHA.trim().slice(0, 12) : null;
  const uptime = Math.round(d.uptimeSeconds());
  const detail = `commit ${sha || 'unknown'} · Node ${process.version} · up ${uptime} s`;
  return result('build', sha ? 'PASS' : 'WARN', detail);
}

function checkSse(d) {
  const s = d.sseStats();
  return result('live connections (SSE)', 'PASS', `${s.totalConnections} open connection(s) across ${s.totalOrgs} org(s)`);
}

async function checkGithubToken(d) {
  const r = await d.checkDispatchToken({ now: d.now() });
  return result('github dispatch token', r.status, r.detail);
}

// The timer stays referenced while the check is in flight (an unref'd timer lets the event
// loop drain under a hanging check) and is cleared as soon as either side settles.
function withTimeout(name, fn, timeoutMs) {
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(result(name, 'FAIL', `timed out after ${timeoutMs / 1000} s`)), timeoutMs);
  });
  const work = Promise.resolve().then(fn).catch((err) => result(name, 'FAIL', `check failed (${(err && err.name) || 'Error'})`));
  return Promise.race([work, timedOut]).finally(() => clearTimeout(timer));
}

/**
 * Run every check in order, reporting each result as soon as it is known via onResult
 * (the route streams these as NDJSON lines). Resolves with the full list.
 */
async function runProductionChecks({ deps = {}, onResult = () => {} } = {}) {
  const d = { ...defaultDeps(), ...deps };
  const plan = [
    ['database', () => checkDatabase(d)],
    ['offsite-backups', () => checkOffsiteBackups(d)],
    ['email', () => checkSmtp(d)],
    ['configuration', () => checkConfiguration(d)],
    ['build', () => checkBuild(d)],
    ['live connections (SSE)', () => checkSse(d)],
    ['github dispatch token', () => checkGithubToken(d)]
  ];
  const results = [];
  const timeoutMs = d.timeoutMs || CHECK_TIMEOUT_MS;
  for (const [name, fn] of plan) {
    const out = await withTimeout(name, fn, timeoutMs);
    for (const r of [].concat(out)) {
      results.push(r);
      onResult(r);
    }
  }
  return results;
}

module.exports = { runProductionChecks, CHECK_TIMEOUT_MS };
