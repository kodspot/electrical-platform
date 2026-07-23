'use strict';

const test = require('node:test');
const assert = require('node:assert');

const VALID_KEY = 'a'.repeat(64); // 32 bytes hex-encoded, matches the 64-char requirement

function withKey(key, fn) {
  const prev = process.env.DATA_ENCRYPTION_KEY;
  process.env.DATA_ENCRYPTION_KEY = key;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = prev;
  }
}

test('encryptField/decryptField round-trip returns the original plaintext', () => {
  withKey(VALID_KEY, () => {
    delete require.cache[require.resolve('../src/lib/crypto')];
    const { encryptField, decryptField } = require('../src/lib/crypto');

    const plaintext = '1234-5678-9012-3456'; // Aadhaar-shaped sample
    const ciphertext = encryptField(plaintext);

    assert.notStrictEqual(ciphertext, plaintext, 'ciphertext must differ from plaintext');
    assert.strictEqual(decryptField(ciphertext), plaintext, 'decrypt must recover the exact original plaintext');
  });
});

test('encryptField produces the versioned v1:iv:ciphertext:tag hex format', () => {
  withKey(VALID_KEY, () => {
    delete require.cache[require.resolve('../src/lib/crypto')];
    const { encryptField } = require('../src/lib/crypto');

    const ciphertext = encryptField('some value');
    const parts = ciphertext.split(':');

    assert.strictEqual(parts.length, 4, 'expected v1:iv:ciphertext:tag');
    assert.strictEqual(parts[0], 'v1');
    assert.match(parts[1], /^[0-9a-f]{24}$/, 'IV must be 12 bytes (24 hex chars)');
    assert.match(parts[3], /^[0-9a-f]{32}$/, 'auth tag must be 16 bytes (32 hex chars)');
  });
});

test('decryptField returns null (never throws) on tampered ciphertext', () => {
  withKey(VALID_KEY, () => {
    delete require.cache[require.resolve('../src/lib/crypto')];
    const { encryptField, decryptField } = require('../src/lib/crypto');

    const ciphertext = encryptField('sensitive value');
    const parts = ciphertext.split(':');
    // Flip one hex character in the ciphertext segment to simulate corruption/tampering
    const flippedChar = parts[2][0] === '0' ? '1' : '0';
    parts[2] = flippedChar + parts[2].slice(1);
    const tampered = parts.join(':');

    assert.doesNotThrow(() => {
      const result = decryptField(tampered);
      assert.strictEqual(result, null, 'tampered ciphertext must decrypt to null, not throw or return garbage');
    });
  });
});

test('encryptField/decryptField are no-ops when DATA_ENCRYPTION_KEY is not configured', () => {
  withKey('', () => {
    delete require.cache[require.resolve('../src/lib/crypto')];
    const { encryptField, decryptField } = require('../src/lib/crypto');

    const plaintext = 'unencrypted-because-no-key';
    assert.strictEqual(encryptField(plaintext), plaintext);
    assert.strictEqual(decryptField(plaintext), plaintext);
  });
});

test('encryptField passes through falsy values unchanged', () => {
  withKey(VALID_KEY, () => {
    delete require.cache[require.resolve('../src/lib/crypto')];
    const { encryptField } = require('../src/lib/crypto');

    assert.strictEqual(encryptField(''), '');
    assert.strictEqual(encryptField(null), null);
    assert.strictEqual(encryptField(undefined), undefined);
  });
});

test('encryptWorkerPII/decryptWorkerPII round-trip Aadhaar and blood group fields', () => {
  withKey(VALID_KEY, () => {
    delete require.cache[require.resolve('../src/lib/crypto')];
    const { encryptWorkerPII, decryptWorkerPII } = require('../src/lib/crypto');

    const worker = { name: 'Test Worker', aadharNo: '9999-8888-7777', bloodGroup: 'O+' };
    const encrypted = encryptWorkerPII({ ...worker });

    assert.notStrictEqual(encrypted.aadharNo, worker.aadharNo);
    assert.notStrictEqual(encrypted.bloodGroup, worker.bloodGroup);
    assert.strictEqual(encrypted.name, worker.name, 'non-PII fields must be untouched');

    const decrypted = decryptWorkerPII({ ...encrypted });
    assert.strictEqual(decrypted.aadharNo, worker.aadharNo);
    assert.strictEqual(decrypted.bloodGroup, worker.bloodGroup);
  });
});

test('decryptWorkerPII handles a worker with no PII fields set', () => {
  withKey(VALID_KEY, () => {
    delete require.cache[require.resolve('../src/lib/crypto')];
    const { decryptWorkerPII } = require('../src/lib/crypto');

    const worker = { name: 'No PII Worker' };
    const result = decryptWorkerPII({ ...worker });
    assert.deepStrictEqual(result, worker);
  });
});

test('decryptWorkerPII returns null/undefined unchanged', () => {
  withKey(VALID_KEY, () => {
    delete require.cache[require.resolve('../src/lib/crypto')];
    const { decryptWorkerPII } = require('../src/lib/crypto');

    assert.strictEqual(decryptWorkerPII(null), null);
    assert.strictEqual(decryptWorkerPII(undefined), undefined);
  });
});
