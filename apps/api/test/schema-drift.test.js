'use strict';

// scripts/schema-drift.js — the F13 migrations-vs-schema gate. The diff command is injected,
// so these tests need no database; the real run happens in `npm run ci` (ci-validate).

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { ALLOWLIST, statementsOf, evaluate, check } = require('../scripts/schema-drift');

// Exactly what `prisma migrate diff` printed after the F13 change (2026-10-14).
const JOIN_TABLES_ONLY = `-- AlterTable
ALTER TABLE "_ElectricalInspectionToWorker" DROP CONSTRAINT "_ElectricalInspectionToWorker_AB_pkey";

-- AlterTable
ALTER TABLE "_TicketResolvedWorkers" DROP CONSTRAINT "_TicketResolvedWorkers_AB_pkey";

-- CreateIndex
CREATE UNIQUE INDEX "_ElectricalInspectionToWorker_AB_unique" ON "_ElectricalInspectionToWorker"("A", "B");

-- CreateIndex
CREATE UNIQUE INDEX "_TicketResolvedWorkers_AB_unique" ON "_TicketResolvedWorkers"("A", "B");
`;
// One of the pre-F13 drift statements: a schema edit the migrations don't carry.
const WITH_DRIFT = `${JOIN_TABLES_ONLY}
-- DropIndex
DROP INDEX "Ticket_sourceIp_createdAt_idx";
`;

const fakeExec = (out) => () => out;

describe('schema drift — decision', () => {
  it('splits the script into normalized statements and drops comments', () => {
    assert.deepStrictEqual(statementsOf(JOIN_TABLES_ONLY), ALLOWLIST);
    assert.deepStrictEqual(statementsOf(''), []);
    assert.deepStrictEqual(statementsOf('-- This is an empty migration.\n'), []);
  });

  it('passes when only the allowlisted join-table statements remain', () => {
    const r = evaluate(JOIN_TABLES_ONLY);
    assert.deepStrictEqual([r.ok, r.unexpected, r.stale], [true, [], []]);
    assert.strictEqual(r.allowed.length, 4);
  });

  it('passes on an empty diff and reports the allowlist as stale (the Prisma 6 cue)', () => {
    const r = evaluate('');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.stale.length, 4);
  });

  it('fails on any statement outside the allowlist', () => {
    const r = evaluate(WITH_DRIFT);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.unexpected, ['DROP INDEX "Ticket_sourceIp_createdAt_idx"']);
  });
});

describe('schema drift — check()', () => {
  const env = { DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/x_ci' };

  it('pass / fail from the diff output', () => {
    assert.strictEqual(check({ env, exec: fakeExec(JOIN_TABLES_ONLY) }).status, 'pass');
    const r = check({ env, exec: fakeExec(WITH_DRIFT) });
    assert.strictEqual(r.status, 'fail');
    assert.match(r.detail, /1 statement\(s\) outside the allowlist/);
  });

  it('runs the diff against DATABASE_URL and the schema', () => {
    let args;
    check({ env, exec: (cmd, a) => { args = a; return ''; } });
    assert.deepStrictEqual(args, ['prisma', 'migrate', 'diff', '--from-url', env.DATABASE_URL, '--to-schema-datamodel', 'prisma/schema.prisma', '--script']);
  });

  it('no database: skip locally, fail under CI=true — and never echo the URL', () => {
    const boom = () => { throw Object.assign(new Error('x'), { stderr: 'Error: P1001: Can\'t reach database server at `127.0.0.1:1`' }); };
    const local = check({ env, exec: boom });
    assert.deepStrictEqual([local.status, /P1001/.test(local.detail)], ['skip', true]);
    const ci = check({ env: { ...env, CI: 'true' }, exec: boom });
    assert.strictEqual(ci.status, 'fail');
    assert.ok(!ci.detail.includes('127.0.0.1') && !ci.detail.includes('u:p'), 'no URL in the detail');
    assert.strictEqual(check({ env: {} }).status, 'skip');
    assert.strictEqual(check({ env: { CI: 'true' } }).status, 'fail');
  });
});
