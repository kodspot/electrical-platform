'use strict';

// bcrypt 5 → 6 (PR #11, ADR 0008): every password and PIN hash already stored was produced by
// bcrypt 5. These hashes were generated with bcrypt 5.1.1 on 2026-10-14 (before the upgrade, in
// a clean copy) and must still verify — and wrong secrets must still be rejected — under the
// installed bcrypt. Plus a round-trip at the app's cost and a hash-format check.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcrypt');

const BCRYPT5_HASHES = [
  { password: 'Kodspot-Compat-Pass1', rounds: 10, hash: '$2b$10$rKlIb.MsmICXppMdBhbrCOq6g5j0AUeEscBDMqydKf.eFNYUdMaBi' },
  { password: '482913', rounds: 12, hash: '$2b$12$Lyj3Iyq1uSB.mP2YLhPlAOOX1SM2KhQzH.X0qpOLoBdnu5lq8TTYa' },
  { password: 'unicode-ü-密码-✓', rounds: 10, hash: '$2b$10$Vdx5oCL88jHdaD.pumCEPuJ6bI6qyotr05I03SY4DKoy2eyZkppzG' }
];

describe('bcrypt — hashes made by bcrypt 5 verify under the installed version', () => {
  it(`runs on bcrypt ${require('bcrypt/package.json').version}`, () => {
    assert.match(require('bcrypt/package.json').version, /^6\./);
  });

  for (const c of BCRYPT5_HASHES) {
    it(`a bcrypt 5 hash (cost ${c.rounds}) verifies, and a wrong secret does not`, async () => {
      assert.strictEqual(await bcrypt.compare(c.password, c.hash), true);
      assert.strictEqual(await bcrypt.compare(`${c.password}x`, c.hash), false);
      assert.strictEqual(bcrypt.getRounds(c.hash), c.rounds);
    });
  }

  it('a new hash at the app cost round-trips and keeps the $2b$ format', async () => {
    const hash = await bcrypt.hash('New-Pass-123', 10);
    assert.match(hash, /^\$2b\$10\$.{53}$/);
    assert.strictEqual(await bcrypt.compare('New-Pass-123', hash), true);
    assert.strictEqual(await bcrypt.compare('new-pass-123', hash), false);
  });
});
