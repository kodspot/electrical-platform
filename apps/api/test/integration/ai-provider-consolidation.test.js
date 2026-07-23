'use strict';

// Regression tests for WP10 (Automation & Alerting Reliability). Covers:
//  - AI provider calling logic — previously duplicated three times
//    (routes/ai.js, services/automation.js, and, indirectly, via a
//    lazy-require, services/predictions.js) — is now a single shared
//    implementation (lib/ai-provider.js) used by all three callers.
//  - callAiProvider() wraps every call in the shared aiBreaker internally,
//    closing the gap where automation.js's generateDailyInsight previously
//    called the provider with zero circuit-breaker protection.
//  - checkMissedInspections (via the exported runScheduledChecks) now reads
//    each org's configured ShiftConfig instead of a hardcoded per-shift
//    deadline table (14:00/22:00/06:00).
//
// global.fetch is stubbed for the provider-calling tests so no real network
// call is made and results are deterministic; each test restores it in a
// finally block. Node's test runner isolates each test file in its own
// process, so this stub never leaks into other test files.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { resolveAiCredentials, callAiProvider } = require('../../src/lib/ai-provider');
const { aiBreaker } = require('../../src/lib/circuit-breaker');
const { encryptField } = require('../../src/lib/crypto');
const { runScheduledChecks } = require('../../src/services/automation');
const { getShiftConfigs } = require('../../src/services/shift-config');
const {
  isDatabaseAvailable,
  createTestOrg,
  createTestLocation,
  createTestAlertRule,
  cleanupTestOrgs
} = require('../helpers/db');
const { prisma } = require('../../src/lib/prisma');

function stubFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

function fakeGeminiResponse(text) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
    })
  };
}

describe('WP10 — consolidated AI provider module (lib/ai-provider.js)', () => {
  describe('resolveAiCredentials', () => {
    it('prefers an org-level key over the global fallback, decrypting it correctly', () => {
      if (!process.env.DATA_ENCRYPTION_KEY) return; // encryption disabled in this environment
      const encrypted = encryptField('org-secret-key');
      const creds = resolveAiCredentials({ aiApiKey: encrypted, aiProvider: 'gemini', aiModel: 'gemini-2.0-flash' });
      assert.strictEqual(creds.apiKey, 'org-secret-key');
      assert.strictEqual(creds.keySource, 'org');
    });

    it('falls back to the global key when the org has none configured', () => {
      const originalKey = process.env.GLOBAL_AI_API_KEY;
      process.env.GLOBAL_AI_API_KEY = 'global-secret-key';
      try {
        const creds = resolveAiCredentials({ aiApiKey: null, aiProvider: null, aiModel: null });
        assert.strictEqual(creds.apiKey, 'global-secret-key');
        assert.strictEqual(creds.keySource, 'global');
      } finally {
        if (originalKey === undefined) delete process.env.GLOBAL_AI_API_KEY;
        else process.env.GLOBAL_AI_API_KEY = originalKey;
      }
    });

    it('returns null when neither an org key nor a global key is configured', () => {
      const originalKey = process.env.GLOBAL_AI_API_KEY;
      delete process.env.GLOBAL_AI_API_KEY;
      try {
        const creds = resolveAiCredentials({ aiApiKey: null, aiProvider: null, aiModel: null });
        assert.strictEqual(creds, null);
      } finally {
        if (originalKey !== undefined) process.env.GLOBAL_AI_API_KEY = originalKey;
      }
    });
  });

  describe('callAiProvider', () => {
    it('defaults an unrecognized provider to Gemini, matching pre-consolidation behavior', async () => {
      let calledUrl = null;
      const restore = stubFetch(async (url) => { calledUrl = url; return fakeGeminiResponse('hello from gemini'); });
      try {
        const result = await callAiProvider(
          { apiKey: 'k', provider: 'some-unknown-provider', model: 'gemini-2.0-flash' },
          'sys', 'user msg', 100, 5000
        );
        assert.match(calledUrl, /generativelanguage\.googleapis\.com/);
        assert.strictEqual(result.content, 'hello from gemini');
      } finally { restore(); }
    });

    it("uses the default 2048 maxTokens when the caller omits it (matches /ai/chat's pre-consolidation reliance on that default)", async () => {
      let sentBody = null;
      const restore = stubFetch(async (url, opts) => { sentBody = JSON.parse(opts.body); return fakeGeminiResponse('ok'); });
      try {
        await callAiProvider({ apiKey: 'k', provider: 'gemini', model: 'gemini-2.0-flash' }, 'sys', 'msg', undefined, 5000);
        assert.strictEqual(sentBody.generationConfig.maxOutputTokens, 2048);
      } finally { restore(); }
    });

    it('classifies a 429 response as a RATE_LIMIT error, and records the failure on the shared aiBreaker', async () => {
      const restore = stubFetch(async () => ({ ok: false, status: 429, text: async () => 'slow down' }));
      const before = aiBreaker.getStatus().totalFailures;
      try {
        await assert.rejects(
          callAiProvider({ apiKey: 'k', provider: 'gemini', model: 'gemini-2.0-flash' }, 'sys', 'msg', 100, 5000),
          (err) => { assert.match(err.message, /GEMINI_RATE_LIMIT/); return true; }
        );
      } finally { restore(); }
      const after = aiBreaker.getStatus().totalFailures;
      assert.strictEqual(after, before + 1, 'the failure must be recorded on the same aiBreaker instance ai.js, automation.js, and predictions.js all share');
    });

    it('dispatches azure-openai credentials to the Azure endpoint', async () => {
      let calledUrl = null;
      const restore = stubFetch(async (url) => {
        calledUrl = url;
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'azure reply' } }], usage: {} }) };
      });
      try {
        const result = await callAiProvider(
          { apiKey: 'https://x.openai.azure.com|secret', provider: 'azure-openai', model: 'gpt-4o' },
          'sys', 'msg', 100, 5000
        );
        assert.match(calledUrl, /openai\.azure\.com/);
        assert.strictEqual(result.content, 'azure reply');
      } finally { restore(); }
    });
  });
});

describe('WP10 — missed-inspection alerting respects ShiftConfig instead of a hardcoded table', () => {
  let dbAvailable = false;
  const createdOrgIds = [];

  before(async () => { dbAvailable = await isDatabaseAvailable(); });
  after(async () => { if (dbAvailable) await cleanupTestOrgs(createdOrgIds); });

  it('fires a missed-inspection alert once a custom ShiftConfig deadline has passed', async (t) => {
    if (!dbAvailable) return t.skip('No database available in this environment');

    const org = await createTestOrg();
    createdOrgIds.push(org.id);
    const location = await createTestLocation(org.id);
    await createTestAlertRule(org.id, { trigger: 'INSPECTION_MISSED', conditions: {}, actions: [] });

    // Deadline == the real current hour, so it has always just passed,
    // regardless of what wall-clock time this test actually runs at.
    const currentHour = new Date().getHours();
    await prisma.shiftConfig.create({
      data: { orgId: org.id, shift: 'MORNING', startHour: 0, startMin: 0, endHour: currentHour, endMin: 0 }
    });

    const configs = await getShiftConfigs(org.id);
    assert.strictEqual(configs.MORNING.endHour, currentHour, "the shared shift-config module must read the org's custom row instead of the hardcoded default (14)");

    const fakeLogger = { info() {}, error() {}, warn() {} };
    await runScheduledChecks(fakeLogger);

    const alert = await prisma.alert.findFirst({
      where: { orgId: org.id, trigger: 'INSPECTION_MISSED', entityId: location.id }
    });
    assert.ok(alert, "a missed-inspection alert must be created once the org's configured MORNING deadline has passed");
  });
});
