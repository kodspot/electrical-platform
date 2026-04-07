'use strict';

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '..', '.env') });

const REQUIRED_ENV = [
  "DATABASE_URL",
  "JWT_SECRET",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "ADMIN_KEY",
  "COOKIE_SECRET"
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required env variable: ${key}`);
    process.exit(1);
  }
}

const isProduction = process.env.NODE_ENV === 'production';
const APP_URL = process.env.APP_URL ?? `http://localhost:${process.env.PORT || 3000}`;

// In production, enforce DATA_ENCRYPTION_KEY for PII safety (Aadhaar, blood group)
if (isProduction) {
  const dek = process.env.DATA_ENCRYPTION_KEY;
  if (!dek || dek.length !== 64 || !/^[0-9a-fA-F]+$/.test(dek)) {
    console.error('FATAL: DATA_ENCRYPTION_KEY must be a 64-character hex string in production. Worker PII would be stored in plaintext without it.');
    process.exit(1);
  }
}

module.exports = { REQUIRED_ENV, isProduction, APP_URL };

// Optional AI env vars (not required — global AI key is a convenience feature)
// GLOBAL_AI_API_KEY, GLOBAL_AI_PROVIDER, GLOBAL_AI_MODEL
