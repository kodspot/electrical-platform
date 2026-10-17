'use strict';

// scripts/change-impact.js — the PR change-impact report (QA-2). Runs against a small fixture
// repository in a temp directory, so the expectations don't move with the real code. No
// database, no git.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { analyze, toMarkdown, toSummary, routeRegex, MARKER } = require('../scripts/change-impact');

let root;
const write = (rel, body) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};
const ids = (r, kind) => r.items.filter((i) => i.kind === kind).map((i) => i.id);
const item = (r, kind, id) => r.items.find((i) => i.kind === kind && i.id === id);

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-'));
  write('apps/api/public/a-page.html', `<script src="/js/app.js?v=1"></script><script>App.apiFetch('/widgets');</script>`);
  write('apps/api/public/b-page.html', `<script src="/js/app.js?v=1"></script><link href="/css/b.css">`);
  write('apps/api/public/lonely.html', '<p>no script</p>');
  write('apps/api/public/js/app.js', '// shared');
  write('apps/api/public/css/b.css', 'p{}');
  write('apps/api/src/lib/util.js', 'module.exports = {};');
  write('apps/api/src/routes/widgets.js', `const u = require('../lib/util');
async function r(fastify) {
  fastify.get('/widgets', async () => []);
  fastify.post('/widgets/:id/zap', async () => ({}));
}`);
  write('docs/reference/routes.generated.md', '| GET | `/api/widgets` |\n| POST | `/api/widgets/:id/zap` |\n');
  write('e2e/tests/journeys.spec.js', `await page.goto(orgPage(slug, 'a-page')); await page.request.get('/api/widgets');`);
  write('apps/api/test/schema-drift.test.js', '// drift');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('change-impact: mapping changed files', () => {
  it('a page file → that page; a page no test names is "not covered"', () => {
    const r = analyze(['apps/api/public/a-page.html', 'apps/api/public/lonely.html'], root);
    assert.deepStrictEqual(ids(r, 'page'), ['a-page', 'lonely']);
    assert.strictEqual(item(r, 'page', 'a-page').covered, true);
    assert.deepStrictEqual(item(r, 'page', 'a-page').coveredBy.map((c) => c.type), ['journey']);
    assert.strictEqual(item(r, 'page', 'lonely').covered, false);
    assert.deepStrictEqual(r.uncovered.map((i) => i.id), ['lonely']);
  });

  it('public/js/app.js → every page that loads it; a stylesheet → the pages that link it', () => {
    assert.deepStrictEqual(ids(analyze(['apps/api/public/js/app.js'], root), 'page'), ['a-page', 'b-page']);
    assert.deepStrictEqual(ids(analyze(['apps/api/public/css/b.css'], root), 'page'), ['b-page']);
  });

  it('a route file → its routes (from the route index), the pages calling them, and their coverage', () => {
    const r = analyze(['apps/api/src/routes/widgets.js'], root);
    assert.deepStrictEqual(ids(r, 'route'), ['GET /api/widgets', 'POST /api/widgets/:id/zap']);
    assert.deepStrictEqual(item(r, 'route', 'GET /api/widgets').pages, ['a-page']);
    assert.strictEqual(item(r, 'route', 'GET /api/widgets').covered, true);
    assert.strictEqual(item(r, 'route', 'POST /api/widgets/:id/zap').covered, false);
  });

  it('a shared server module → the routes of every route file that requires it', () => {
    assert.deepStrictEqual(ids(analyze(['apps/api/src/lib/util.js'], root), 'route'), ['GET /api/widgets', 'POST /api/widgets/:id/zap']);
  });

  it('prisma → the data model (covered by the schema-drift gate) and each migration', () => {
    const r = analyze(['apps/api/prisma/schema.prisma', 'apps/api/prisma/migrations/20261017_x/migration.sql'], root);
    assert.deepStrictEqual(ids(r, 'data'), ['data model (schema.prisma)', 'migration 20261017_x']);
    assert.strictEqual(item(r, 'data', 'data model (schema.prisma)').covered, true);
  });

  it('tests, CI and docs are listed with no runtime impact; unknown files are "not mapped"', () => {
    const r = analyze(['e2e/tests/journeys.spec.js', '.github/workflows/x.yml', 'docs/a.md', 'Caddyfile'], root);
    assert.strictEqual(r.items.length, 0);
    assert.deepStrictEqual(r.other.map((o) => o.note), ['tests', 'CI', 'docs', 'not mapped']);
  });

  it('the explorer covers every page of the route table, named or not', () => {
    write('e2e/tests/explorer.spec.js', '// every page as every role');
    try {
      const r = analyze(['apps/api/public/lonely.html'], root);
      assert.deepStrictEqual(item(r, 'page', 'lonely').coveredBy.map((c) => c.type), ['explorer']);
    } finally {
      fs.rmSync(path.join(root, 'e2e/tests/explorer.spec.js'));
    }
  });

  it('a route path matches an interpolated call, not a longer sibling', () => {
    const re = routeRegex('/api/tickets/:id/resolve');
    assert.ok(re.test("request.post(`/api/tickets/${t.id}/resolve`)"));
    assert.ok(!re.test("'/api/tickets/abc/resolve-later'"));
    assert.ok(!routeRegex('/api/tickets').test("'/api/tickets-archive'"));
  });
});

describe('change-impact: output', () => {
  it('the comment carries the marker, the counts and a "not covered" section', () => {
    const md = toMarkdown(analyze(['apps/api/public/lonely.html', 'apps/api/src/routes/widgets.js'], root), { base: 'main', head: 'abcdef1234' });
    assert.ok(md.startsWith(MARKER));
    assert.match(md, /1 page\(s\)\*\*, \*\*2 API route\(s\)/);
    assert.match(md, /### ⚠️ Changed but not covered/);
    assert.match(md, /- page `lonely`/);
    assert.match(md, /- route `POST \/api\/widgets\/:id\/zap`/);
  });

  it('everything covered → no "not covered" section', () => {
    const md = toMarkdown(analyze(['apps/api/public/a-page.html'], root));
    assert.match(md, /Every affected item is covered by a test\./);
    assert.doesNotMatch(md, /Changed but not covered/);
  });

  it('the ingest summary counts covered items as pass and uncovered ones as fail', () => {
    const s = toSummary(analyze(['apps/api/public/a-page.html', 'apps/api/public/lonely.html'], root));
    assert.deepStrictEqual(s.counts, { tests: 2, pass: 1, fail: 1, cancelled: 0, skipped: 0, todo: 0 });
    assert.strictEqual(s.status, 'not_covered');
    assert.deepStrictEqual(s.uncovered, ['page lonely']);
  });

  it('the CLI never fails the build, even when git cannot answer', () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'change-impact.js'), '--base', 'no-such-ref-qa2'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.match(r.stderr, /could not compute the report/);
  });
});
