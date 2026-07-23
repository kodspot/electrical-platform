'use strict';

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '..', '.env') });

// R2 object-storage credentials are required only for the default 'r2' storage
// driver. With STORAGE_DRIVER=local (development), images are stored on the local
// filesystem (see lib/r2.js) and no cloud credentials are needed to boot — this is
// what lets a new developer run the app without any cloud account. Production leaves
// STORAGE_DRIVER unset (or 'r2'), so its required-secret set is unchanged.
const usingLocalStorage = (process.env.STORAGE_DRIVER || '').toLowerCase() === 'local';

const REQUIRED_ENV = [
  "DATABASE_URL",
  "JWT_SECRET",
  ...(usingLocalStorage ? [] : [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME"
  ]),
  "ADMIN_KEY",
  "COOKIE_SECRET"
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required env variable: ${key}`);
    process.exit(1);
  }
}

// Secrets used to sign/verify auth tokens, cookies, and the admin bootstrap
// key must be more than merely "present" — a short or trivially guessable
// value here is a critical, silent vulnerability (forgeable JWTs, forgeable
// cookies, a guessable admin key), and unlike DATA_ENCRYPTION_KEY's format
// requirement (a wrong length there breaks decryption outright, so it was
// already enforced), nothing previously caught a weak-but-technically-valid
// value for these three. .env.example has always documented the intended
// length (64/64/32 hex chars) — this just makes that expectation load-bearing
// rather than a comment nobody has to follow. [WP13]
const MIN_SECRET_LENGTH = { JWT_SECRET: 32, COOKIE_SECRET: 32, ADMIN_KEY: 16 };
for (const [key, minLength] of Object.entries(MIN_SECRET_LENGTH)) {
  if (process.env[key].length < minLength) {
    console.error(`FATAL: ${key} is only ${process.env[key].length} characters — must be at least ${minLength}. A short secret here is forgeable. See .env.example for how to generate one.`);
    process.exit(1);
  }
}

const isProduction = process.env.NODE_ENV === 'production';

// NODE_ENV controls production-safe defaults throughout the app (query-level
// log verbosity in lib/prisma.js, permissive-vs-restricted CORS in
// plugins/security.js) — every real deployment path (docker-compose.yml, both
// GitHub Actions workflows) explicitly sets it to 'production' or 'test', so
// an unrecognized value reaching this point is almost certainly a typo
// (e.g. 'Production', 'prod') that would otherwise silently disable those
// defaults. A warning, not a fatal exit, since a genuinely unset NODE_ENV is
// this codebase's existing, intentional local-dev convention. [WP13]
const KNOWN_NODE_ENVS = ['production', 'development', 'test'];
if (process.env.NODE_ENV && !KNOWN_NODE_ENVS.includes(process.env.NODE_ENV)) {
  console.warn(`WARNING: NODE_ENV="${process.env.NODE_ENV}" is not one of ${KNOWN_NODE_ENVS.join('/')} — likely a typo. Production-safe defaults (verbose query logging off, CORS restricted) only activate when NODE_ENV is exactly "production".`);
}

const APP_URL = process.env.APP_URL ?? `http://localhost:${process.env.PORT || 3000}`;

// IP_HASH_PEPPER strengthens the public-complaint abuse-detection IP hash
// (routes/public.js) against precomputation/correlation across deployments
// that would otherwise share the same unsalted SHA-256(ip) scheme. Optional
// with a safe fallback (unpeppered hash, identical to pre-WP11 behavior) so
// an existing deployment upgrading without setting it yet doesn't break —
// matching the NODE_ENV warning's non-fatal pattern above. Only warn in
// production; local/test setups don't need this hardening. [WP11]
if (isProduction && !process.env.IP_HASH_PEPPER) {
  console.warn('WARNING: IP_HASH_PEPPER is not set — public-complaint abuse-detection IP hashing will run unpeppered. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}

// Enforce DATA_ENCRYPTION_KEY for PII safety (Aadhaar, blood group) in every
// environment — this must never be conditional on NODE_ENV. A non-production
// environment (staging, a demo, a misconfigured deploy) can hold real PII just as
// easily as production can, and a plaintext fallback there is exactly the gap this
// check exists to close.
{
  const dek = process.env.DATA_ENCRYPTION_KEY;
  if (!dek || dek.length !== 64 || !/^[0-9a-fA-F]+$/.test(dek)) {
    console.error('FATAL: DATA_ENCRYPTION_KEY must be a 64-character hex string. Worker PII would be stored in plaintext without it. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }
}

module.exports = { REQUIRED_ENV, isProduction, APP_URL };

// Optional AI env vars (not required — global AI key is a convenience feature)
// GLOBAL_AI_API_KEY, GLOBAL_AI_PROVIDER, GLOBAL_AI_MODEL
