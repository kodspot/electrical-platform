'use strict';

/**
 * Decision logic for the test-process safety guard (QA-1). Loading this module has no
 * side effects: it only judges an environment; test/setup/safety.js applies the verdict
 * as a preload, and test/helpers/db.js re-checks it before touching the database.
 *
 * Messages deliberately never contain the URL, host, database name, or any other value
 * read from the environment or a .env file — only which rule failed, where the value
 * came from, and how to fix it.
 */

const fs = require('fs');
const path = require('path');

const ROOT_ENV_PATH = path.join(__dirname, '..', '..', '..', '..', '.env');

// The text the app's dotenv call (src/config/env.js) would read, or null if absent.
function readRootEnvText() {
  try {
    return fs.readFileSync(ROOT_ENV_PATH, 'utf8');
  } catch {
    return null;
  }
}

const OUTBOUND_BLANKED = [
  'SES_SMTP_HOST', 'SES_SMTP_USER', 'SES_SMTP_PASS', 'SES_FROM_EMAIL',
  'ALERT_TELEGRAM_BOT_TOKEN', 'ALERT_TELEGRAM_CHAT_ID', 'ALERT_WEBHOOK_URL',
  'GLOBAL_AI_API_KEY', 'GLOBAL_AI_PROVIDER', 'GLOBAL_AI_MODEL'
];
const R2_PLACEHOLDERS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
const R2_PLACEHOLDER_VALUE = 'test-placeholder';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
// libpq/Prisma connection parameters that can redirect a connection away from the
// host and database the URL's authority and path appear to name.
const FORBIDDEN_QUERY_PARAMS = new Set(['host', 'hostaddr', 'port', 'dbname', 'service']);
const DB_NAME_CHARS = /^[A-Za-z0-9_]+$/;
const DB_NAME_SUFFIX = /_(ci|test|e2e)$/;

const FIX_HINT =
  'Run tests only against a disposable loopback database whose name ends in _ci, _test or _e2e, ' +
  'passed explicitly, e.g. DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:5432/electrical_test ' +
  '(see apps/api/test/README.md).';

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function refuse(code, source, detail) {
  return { ok: false, code, source, message: `${detail} ${FIX_HINT}` };
}

/**
 * Decide whether this process may run tests.
 *
 * @param {object} args
 * @param {object} args.env         the environment to judge (normally process.env)
 * @param {string|null} args.dotenvText  contents of the repo-root .env, or null if absent.
 *   Consulted only when env has no DATABASE_URL key at all, because dotenv never
 *   overrides a key that is already set (even to '').
 * @returns {{ ok: boolean, code: string, source: 'ambient'|'.env'|'none', message: string }}
 */
function evaluateTarget({ env, dotenvText = null }) {
  if (env.NODE_ENV !== 'test') {
    return refuse('NODE_ENV_NOT_TEST', 'none', 'Refusing to run tests: NODE_ENV must be exactly "test".');
  }

  const isCI = env.CI === 'true';
  const ambient = hasOwn(env, 'DATABASE_URL');

  if (isCI && !(ambient && env.DATABASE_URL)) {
    return refuse('CI_REQUIRES_AMBIENT_URL', 'none',
      'Refusing to run tests: CI=true requires an explicit, non-empty DATABASE_URL in the environment (a .env file is never used in CI).');
  }

  let value;
  let source;
  if (ambient) {
    value = env.DATABASE_URL;
    source = 'ambient';
  } else if (dotenvText) {
    const parsed = require('dotenv').parse(dotenvText);
    value = parsed.DATABASE_URL;
    source = '.env';
  }

  if (!value) {
    // No database target at all. Nothing can be harmed; src/config/env.js refuses to
    // boot the app without DATABASE_URL, so DB-backed tests cannot reach any database.
    return { ok: true, code: 'NO_TARGET', source: 'none', message: 'No DATABASE_URL configured.' };
  }

  const from = `DATABASE_URL (from ${source === 'ambient' ? 'the environment' : 'the repo-root .env'})`;

  let url;
  try {
    url = new URL(value);
  } catch {
    return refuse('UNPARSEABLE', source, `Refusing to run tests: ${from} could not be parsed as a URL.`);
  }

  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    return refuse('BAD_PROTOCOL', source, `Refusing to run tests: ${from} is not a postgresql:// URL.`);
  }

  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    return refuse('NON_LOOPBACK_HOST', source,
      `Refusing to run tests: ${from} does not point at a loopback host (127.0.0.1, localhost, ::1).`);
  }

  for (const key of url.searchParams.keys()) {
    if (FORBIDDEN_QUERY_PARAMS.has(key.toLowerCase())) {
      return refuse('FORBIDDEN_QUERY_PARAM', source,
        `Refusing to run tests: ${from} carries a connection-redirecting query parameter (host, hostaddr, port, dbname or service).`);
    }
  }

  let dbName;
  try {
    dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return refuse('UNPARSEABLE', source, `Refusing to run tests: ${from} has an undecodable database name.`);
  }
  if (!DB_NAME_CHARS.test(dbName) || !DB_NAME_SUFFIX.test(dbName)) {
    return refuse('BAD_DB_NAME', source,
      `Refusing to run tests: ${from} does not name a test database (letters, digits and _ only, ending in _ci, _test or _e2e).`);
  }

  return { ok: true, code: 'SAFE_TARGET', source, message: `${from} is a loopback test database.` };
}

/**
 * Post-load re-check used by test/helpers/db.js right before a test touches the database.
 *
 * src/lib/prisma.js builds its client from process.env.DATABASE_URL once, when the module is
 * first evaluated, and never re-reads it: a value that appears or changes later (e.g. dotenv
 * injecting the .env value when src/config/env.js loads after prisma.js) is not used — an
 * empty captured value makes every query fail validation instead. So the URL Prisma can reach
 * is the captured one when db.js knows it (`capturedUrl`, recorded if db.js is the first
 * loader of prisma.js), and otherwise the current process.env value. Both are judged.
 */
function evaluateEffectiveTarget({ env, dotenvText = null, capturedUrl }) {
  const current = evaluateTarget({ env, dotenvText });
  if (!current.ok || capturedUrl === undefined || capturedUrl === env.DATABASE_URL) return current;
  return evaluateTarget({ env: { ...env, DATABASE_URL: capturedUrl }, dotenvText: null });
}

module.exports = {
  evaluateTarget,
  evaluateEffectiveTarget,
  readRootEnvText,
  OUTBOUND_BLANKED,
  R2_PLACEHOLDERS,
  R2_PLACEHOLDER_VALUE
};
