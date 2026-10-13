'use strict';

/**
 * The single place this app calls the GitHub REST API, for the super-admin Quality page:
 * reading CI run status, checking the dispatch token, and starting the e2e workflow.
 * [WP-Q, ADR 0005]
 *
 * - Optional token: GH_ACTIONS_DISPATCH_TOKEN (fine-grained, this repo only, Actions
 *   read+write). Without it, reads fall back to unauthenticated requests, which a public
 *   repository allows (at a low rate limit).
 * - Every call has a 10 s timeout. Errors are reduced to a short reason
 *   ("http 403", "timeout", "network") — never a URL, header or token.
 */

const API = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const DEFAULT_REPO = 'kodspot/electrical-platform';
const TIMEOUT_MS = 10_000;
const CI_STATUS_TTL_MS = 60_000;

function repo() {
  const r = (process.env.QA_GITHUB_REPO || '').trim();
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r) ? r : DEFAULT_REPO;
}

function headers(extra = {}) {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'kodspot-quality-dashboard',
    ...extra
  };
  if (process.env.GH_ACTIONS_DISPATCH_TOKEN) h.Authorization = `Bearer ${process.env.GH_ACTIONS_DISPATCH_TOKEN}`;
  return h;
}

function reasonOf(err) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  return 'network';
}

/** fetch with the standard headers and timeout. Returns the Response; throws only on network/timeout. */
async function githubFetch(pathname, { method = 'GET', body, timeoutMs = TIMEOUT_MS } = {}) {
  return fetch(`${API}${pathname}`, {
    method,
    headers: headers(body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });
}

const RUN_FIELDS = ['id', 'name', 'head_branch', 'event', 'status', 'conclusion', 'created_at', 'updated_at', 'html_url', 'head_sha'];

function pickRun(run) {
  const out = {};
  for (const k of RUN_FIELDS) out[k === 'head_branch' ? 'branch' : k] = run[k] ?? null;
  return out;
}

let ciCache = { at: 0, value: null };

/** Latest 10 workflow runs (whitelisted fields only), cached for 60 s. Never throws. */
async function getCiStatus({ now = Date.now() } = {}) {
  if (ciCache.value && now - ciCache.at < CI_STATUS_TTL_MS) return { ...ciCache.value, cached: true };
  let value;
  try {
    const res = await githubFetch(`/repos/${repo()}/actions/runs?per_page=10`);
    if (!res.ok) {
      value = { state: 'unavailable', reason: `http ${res.status}` };
    } else {
      const body = await res.json();
      value = { state: 'ok', runs: (body.workflow_runs || []).map(pickRun) };
    }
  } catch (err) {
    value = { state: 'unavailable', reason: reasonOf(err) };
  }
  value.fetchedAt = new Date(now).toISOString();
  ciCache = { at: now, value };
  return { ...value, cached: false };
}

function _resetCiCacheForTests() { ciCache = { at: 0, value: null }; }

/**
 * Checks GH_ACTIONS_DISPATCH_TOKEN with one authenticated call. A fine-grained token's
 * expiry arrives in the `github-authentication-token-expiration` response header.
 * Returns { status: PASS|WARN|FAIL|SKIPPED, detail } — never the token, URL or header value
 * beyond the computed day count.
 */
async function checkDispatchToken({ now = Date.now() } = {}) {
  if (!process.env.GH_ACTIONS_DISPATCH_TOKEN) return { status: 'SKIPPED', detail: 'dispatch token not configured' };
  let res;
  try {
    res = await githubFetch(`/repos/${repo()}`);
  } catch (err) {
    return { status: 'FAIL', detail: `GitHub unreachable (${reasonOf(err)})` };
  }
  if (res.status === 401) return { status: 'FAIL', detail: 'token rejected (401): expired or revoked' };
  if (!res.ok) return { status: 'FAIL', detail: `GitHub answered http ${res.status}` };
  const expiry = res.headers.get('github-authentication-token-expiration');
  if (!expiry) return { status: 'PASS', detail: 'token accepted; expiry unknown' };
  // Seen as "2026-12-31 23:59:59 UTC" and "2026-12-31 23:59:59 +0000".
  const iso = expiry.trim()
    .replace(/ UTC$/, 'Z')
    .replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T')
    .replace(/ ?([+-]\d{2})(\d{2})$/, '$1:$2');
  const expiresAt = Date.parse(iso);
  if (Number.isNaN(expiresAt)) return { status: 'PASS', detail: 'token accepted; expiry unknown' };
  const days = Math.floor((expiresAt - now) / 86_400_000);
  if (expiresAt <= now) return { status: 'FAIL', detail: 'token expired' };
  if (days < 14) return { status: 'WARN', detail: `token expires in ${days} day(s) — rotate it` };
  return { status: 'PASS', detail: `token accepted; expires in ${days} days` };
}

const E2E_WORKFLOW = 'e2e.yml';

/**
 * Start the e2e workflow (workflow_dispatch on main). Returns { outcome, githubStatus, url }:
 *   started            — 200 (url = the run's html_url, https://github.com/ only) or 204 (url null)
 *   not_on_main        — 404 / 422: the workflow file is not on main yet
 *   token_rejected     — 401 / 403
 *   github_unavailable — 429, any other status, a timeout or a network error
 *   disabled           — GH_ACTIONS_DISPATCH_TOKEN unset (no call made)
 * githubStatus is the HTTP status or "timeout"/"network" — never a URL, header or token.
 */
async function dispatchE2eWorkflow({ requestedBy = 'superadmin' } = {}) {
  if (!process.env.GH_ACTIONS_DISPATCH_TOKEN) return { outcome: 'disabled', githubStatus: null, url: null };
  let res;
  try {
    res = await githubFetch(`/repos/${repo()}/actions/workflows/${E2E_WORKFLOW}/dispatches`, {
      method: 'POST',
      body: { ref: 'main', inputs: { requested_by: requestedBy } }
    });
  } catch (err) {
    return { outcome: 'github_unavailable', githubStatus: reasonOf(err), url: null };
  }
  const s = res.status;
  if (s === 200) {
    let url = null;
    try {
      const body = await res.json();
      if (typeof body.html_url === 'string' && body.html_url.startsWith('https://github.com/')) url = body.html_url;
    } catch { /* a 200 without a usable body is still a started run */ }
    return { outcome: 'started', githubStatus: 200, url };
  }
  if (s === 204) return { outcome: 'started', githubStatus: 204, url: null };
  if (s === 404 || s === 422) return { outcome: 'not_on_main', githubStatus: s, url: null };
  if (s === 401 || s === 403) return { outcome: 'token_rejected', githubStatus: s, url: null };
  return { outcome: 'github_unavailable', githubStatus: s, url: null };
}

module.exports = { repo, githubFetch, getCiStatus, checkDispatchToken, dispatchE2eWorkflow, _resetCiCacheForTests, API_VERSION };
