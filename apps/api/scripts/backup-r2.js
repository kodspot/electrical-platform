#!/usr/bin/env node
'use strict';

/**
 * Offsite backup storage helper — uploads/lists/downloads/prunes database backup
 * archives in Cloudflare R2, so a backup survives the loss of the host it protects.
 *
 * Reuses the same R2 account/credentials the app already requires (R2_ACCOUNT_ID,
 * R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) under a separate key prefix (db-backups/),
 * with an optional R2_BACKUP_BUCKET_NAME to use a dedicated bucket instead of the
 * one used for uploaded images — falls back to R2_BUCKET_NAME if unset, so this
 * works with zero new infrastructure by default.
 *
 * Usage:
 *   node backup-r2.js upload <localFilePath>
 *   node backup-r2.js upload - <name>          # body from stdin (name: kodspot_YYYYMMDD_HHMMSS.sql.gz)
 *   node backup-r2.js list
 *   node backup-r2.js download <key> <destPath|->
 *   node backup-r2.js download-latest <destPath|->
 *   node backup-r2.js prune <retentionDays>
 *
 * The production host has no Node.js: infrastructure/backup-db.sh and restore-db.sh run this
 * script inside the app container (`docker compose exec -T api node scripts/backup-r2.js ...`)
 * and stream the archive through stdin/stdout ("-"), so the container never needs access to
 * the host's backup directory. In stdout mode every log line goes to stderr.
 */

const path = require('path');
const fs = require('fs');

// quiet: dotenv 17 otherwise prints a banner to stdout, which would corrupt `download ... -`.
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env'), quiet: true });

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');

const REQUIRED = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`Missing required env variable: ${key}`);
    process.exit(1);
  }
}

const BUCKET_NAME = process.env.R2_BACKUP_BUCKET_NAME || process.env.R2_BUCKET_NAME;
if (!BUCKET_NAME) {
  console.error('Missing required env variable: R2_BACKUP_BUCKET_NAME or R2_BUCKET_NAME');
  process.exit(1);
}

const PREFIX = 'db-backups/';

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  },
  maxAttempts: 3
});

const STDIN_NAME = /^kodspot_\d{8}_\d{6}\.sql\.gz$/;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function upload(localFilePath, stdinName) {
  let key;
  let body;
  if (localFilePath === '-') {
    if (!STDIN_NAME.test(stdinName || '')) throw new Error('upload -: the name must look like kodspot_YYYYMMDD_HHMMSS.sql.gz');
    key = PREFIX + stdinName;
    body = await readStdin();
    if (body.length === 0) throw new Error('upload -: stdin was empty');
  } else {
    if (!fs.existsSync(localFilePath)) {
      throw new Error(`File not found: ${localFilePath}`);
    }
    key = PREFIX + path.basename(localFilePath);
    body = fs.readFileSync(localFilePath);
  }
  await client.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: 'application/gzip'
  }));
  console.log(`Uploaded ${localFilePath === '-' ? 'stdin' : localFilePath} (${body.length} bytes) -> r2://${BUCKET_NAME}/${key}`);
}

async function list() {
  const objects = [];
  let ContinuationToken;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: PREFIX,
      ContinuationToken
    }));
    for (const obj of res.Contents || []) objects.push(obj);
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  objects.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));
  return objects;
}

async function downloadOne(key, destPath) {
  const res = await client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  if (destPath === '-') {
    await new Promise((resolve, reject) => process.stdout.write(body, (err) => (err ? reject(err) : resolve())));
    console.error(`Downloaded r2://${BUCKET_NAME}/${key} (${body.length} bytes) -> stdout`);
    return;
  }
  fs.writeFileSync(destPath, body);
  console.log(`Downloaded r2://${BUCKET_NAME}/${key} -> ${destPath}`);
}

async function prune(retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const objects = await list();
  const stale = objects.filter((o) => new Date(o.LastModified).getTime() < cutoff);
  for (const obj of stale) {
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: obj.Key }));
    console.log(`Pruned offsite backup older than ${retentionDays}d: ${obj.Key}`);
  }
  console.log(`Pruned ${stale.length} offsite backup(s) older than ${retentionDays} days`);
}

async function main() {
  const [, , cmd, ...args] = process.argv;

  if (cmd === 'upload') {
    if (!args[0]) throw new Error('Usage: backup-r2.js upload <localFilePath> | upload - <name>');
    await upload(args[0], args[1]);
  } else if (cmd === 'list') {
    const objects = await list();
    if (objects.length === 0) {
      console.log('No offsite backups found.');
    } else {
      for (const obj of objects) {
        console.log(`${obj.Key}\t${obj.Size} bytes\t${obj.LastModified.toISOString()}`);
      }
    }
  } else if (cmd === 'download') {
    if (!args[0] || !args[1]) throw new Error('Usage: backup-r2.js download <key> <destPath>');
    await downloadOne(args[0], args[1]);
  } else if (cmd === 'download-latest') {
    if (!args[0]) throw new Error('Usage: backup-r2.js download-latest <destPath>');
    const objects = await list();
    if (objects.length === 0) throw new Error('No offsite backups found to download.');
    await downloadOne(objects[0].Key, args[0]);
  } else if (cmd === 'prune') {
    const days = parseInt(args[0], 10);
    if (!days || days < 1) throw new Error('Usage: backup-r2.js prune <retentionDays>');
    await prune(days);
  } else {
    console.error('Usage: backup-r2.js <upload|list|download|download-latest|prune> [args]');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('backup-r2.js failed:', err.message);
  process.exit(1);
});
