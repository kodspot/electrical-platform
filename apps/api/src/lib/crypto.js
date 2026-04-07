'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_VERSION = 'v1'; // Prepended to ciphertext for future key rotation support

let _warnedNoKey = false;

function getKey() {
  const hex = process.env.DATA_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    if (!_warnedNoKey) { console.warn('⚠ DATA_ENCRYPTION_KEY not set or invalid — encryption disabled'); _warnedNoKey = true; }
    return null;
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext string. Returns "v1:iv:ciphertext:tag" (hex-encoded).
 * The key version prefix enables future key rotation — data encrypted with
 * an older key can be detected and re-encrypted transparently.
 * Returns the original value unchanged if encryption key is not configured.
 */
function encryptField(plaintext) {
  if (!plaintext) return plaintext;
  const key = getKey();
  if (!key) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return KEY_VERSION + ':' + iv.toString('hex') + ':' + encrypted.toString('hex') + ':' + tag.toString('hex');
}

/**
 * Decrypt a "v1:iv:ciphertext:tag" or legacy "iv:ciphertext:tag" string back to plaintext.
 * Returns the original value unchanged if it doesn't look encrypted or key is missing.
 */
function decryptField(ciphertext) {
  if (!ciphertext) return ciphertext;
  const key = getKey();
  if (!key) return ciphertext;

  let parts = ciphertext.split(':');

  // Handle versioned format: "v1:iv:ciphertext:tag"
  if (parts[0] === KEY_VERSION && parts.length === 4) {
    parts = parts.slice(1); // strip version prefix
  } else if (parts.length !== 3) {
    return ciphertext; // not encrypted, return as-is
  }

  try {
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = Buffer.from(parts[1], 'hex');
    const tag = Buffer.from(parts[2], 'hex');

    if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) return ciphertext;

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
  } catch (err) {
    // Log decryption failures for tamper/corruption detection (no sensitive data in log)
    console.error(`[crypto] Decryption failed — possible data corruption or key mismatch (length=${ciphertext.length})`);
    return null;
  }
}

/** Encrypt sensitive worker fields in-place before database write */
function encryptWorkerPII(data) {
  if (data.aadharNo) data.aadharNo = encryptField(data.aadharNo);
  if (data.bloodGroup) data.bloodGroup = encryptField(data.bloodGroup);
  return data;
}

/** Decrypt sensitive worker fields in-place after database read */
function decryptWorkerPII(worker) {
  if (!worker) return worker;
  if (worker.aadharNo) worker.aadharNo = decryptField(worker.aadharNo) || worker.aadharNo;
  if (worker.bloodGroup) worker.bloodGroup = decryptField(worker.bloodGroup) || worker.bloodGroup;
  return worker;
}

module.exports = { encryptField, decryptField, encryptWorkerPII, decryptWorkerPII };
