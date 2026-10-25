'use strict';

// One phone, several sessions: a supervisor and an admin (or an electrician) signed in on the
// same device. A supervisor's inspection saved offline was replayed, once back online on any
// page, with the first token found — the admin's if there was one — so it was recorded as the
// admin's. Photo URLs on a page also carried the first token found, not that page's own.
// Each now uses its own role's session. [BUG-0054]

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const TOKENS = { token: 'ADMIN-TOKEN', sup_token: 'SUP-TOKEN', elec_token: 'ELEC-TOKEN' };

/** app.js on a device holding `stored` sessions, with an offline queue holding `queued`. */
function loadApp({ stored = TOKENS, queued = [], pathname = '/' } = {}) {
  const noop = () => {};
  const listeners = {};
  const sent = [];
  const enqueued = [];
  const removed = [];
  const sandbox = {
    window: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      KodspotSync: {
        getAll: async () => queued,
        remove: async (id) => { removed.push(id); },
        count: async () => queued.length,
        enqueue: async (entry) => { enqueued.push(entry); return 1; }
      }
    },
    navigator: { onLine: false },
    location: { pathname, href: '' },
    localStorage: { getItem: (k) => (k in stored ? stored[k] : null), setItem: noop, removeItem: noop },
    document: {
      addEventListener: noop, querySelector: () => null, getElementById: () => null, body: { appendChild: noop },
      createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, appendChild: noop, remove: noop, addEventListener: noop, innerHTML: '', textContent: '' })
    },
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout: noop, FormData: class FormData {},
    fetch: async (url, opts) => {
      sent.push({ url, authorization: (opts && opts.headers && opts.headers.Authorization) || null });
      return { status: 201, ok: true, json: async () => ({}) };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8'), sandbox);
  sandbox.window.App.toast = noop;
  const settle = () => new Promise((r) => setImmediate(r));
  return { App: sandbox.window.App, listeners, sent, enqueued, removed, settle };
}

const inspection = (extra) => ({ id: 1, url: 'http://x/api/electrical-inspections', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', ...extra });

describe('BUG-0054: on a shared device, each request uses its own role\'s session', () => {
  it('a supervisor\'s saved inspection is replayed with the supervisor\'s token, even with an admin signed in too', async () => {
    const { listeners, sent, removed, settle } = loadApp({ queued: [inspection({ scope: 'supervisor' })] });
    listeners.online();
    for (let i = 0; i < 5; i++) await settle();
    assert.deepStrictEqual(sent.map((s) => s.authorization), ['Bearer SUP-TOKEN']);
    assert.deepStrictEqual(removed, [1]);
  });

  it('an entry saved before the role was recorded (only the supervisor inspection page queues) is a supervisor\'s', async () => {
    const { listeners, sent, settle } = loadApp({ queued: [inspection()] });
    listeners.online();
    for (let i = 0; i < 5; i++) await settle();
    assert.deepStrictEqual(sent.map((s) => s.authorization), ['Bearer SUP-TOKEN']);
  });

  it('with the supervisor signed out, the entry waits; it is not sent with another role\'s token', async () => {
    const { listeners, sent, removed, settle } = loadApp({ stored: { token: 'ADMIN-TOKEN' }, queued: [inspection({ scope: 'supervisor' })] });
    listeners.online();
    for (let i = 0; i < 5; i++) await settle();
    assert.deepStrictEqual(sent, []);
    assert.deepStrictEqual(removed, []);
  });

  it('the inspection page records the role with what it queues', async () => {
    const { App, enqueued, settle } = loadApp();
    App.enqueueRetry(null, inspection({ id: undefined, scope: 'supervisor' }));
    await settle();
    assert.strictEqual(enqueued[0].scope, 'supervisor');
    const page = fs.readFileSync(path.join(PUBLIC, 'supervisor-electrical.html'), 'utf8');
    assert.ok(/App\.enqueueRetry\(null, \{\s*scope: 'supervisor',/.test(page), 'supervisor-electrical.html queues with scope "supervisor"');
  });

  it('photo URLs carry the session of the page they are on', () => {
    for (const [page, token] of [['/kodspot/ele/supervisor-tickets', 'SUP-TOKEN'], ['/kodspot/ele/electrician-tickets', 'ELEC-TOKEN'], ['/kodspot/ele/admin-tickets', 'ADMIN-TOKEN']]) {
      const { App } = loadApp({ pathname: page });
      assert.strictEqual(App.imgUrl('/images/org/a.jpg'), `/api/images/org/a.jpg?token=${token}`, page);
    }
  });
});
