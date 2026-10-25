'use strict';

// "Today" on the admin pages (preset ranges, the dashboard's inspection log, CSV file names)
// came from toISOString(), the UTC date — yesterday, between 00:00 and 05:30 in India. Pages
// use App.localDate() and the server lib/dates.js localDateKey(). [BUG-0055]
process.env.TZ = 'Asia/Kolkata';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { localDateKey } = require('../src/lib/dates');

const PUBLIC = path.join(__dirname, '..', 'public');
const PAGES = ['admin-analytics.html', 'admin-assets.html', 'admin-audit-logs.html', 'admin-dashboard.html', 'admin-electrical.html', 'admin-failures.html'];

function loadApp() {
  const noop = () => {};
  const sandbox = {
    window: { addEventListener: noop }, navigator: {}, location: { pathname: '/' },
    localStorage: { getItem: () => null }, document: { addEventListener: noop }
  };
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8'), sandbox);
  return sandbox.window.App;
}

describe('BUG-0055: "today" is the local date', () => {
  const justAfterMidnight = new Date('2026-03-10T00:30:00+05:30');

  it('App.localDate and localDateKey give the local date, where toISOString gives the day before', () => {
    assert.strictEqual(justAfterMidnight.toISOString().slice(0, 10), '2026-03-09', 'the UTC date (the old way)');
    assert.strictEqual(loadApp().localDate(justAfterMidnight), '2026-03-10');
    assert.strictEqual(localDateKey(justAfterMidnight), '2026-03-10');
    assert.strictEqual(loadApp().localDate(new Date('2026-12-31T23:59:00+05:30')), '2026-12-31');
  });

  it('no admin page takes a date from toISOString()', () => {
    for (const page of PAGES) {
      const src = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
      assert.ok(!/toISOString\(\)\.(split\('T'\)\[0\]|slice\(0, *10\))/.test(src), `${page} takes a date from UTC`);
    }
  });
});
