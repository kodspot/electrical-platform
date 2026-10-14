'use strict';

// lib/email.js against nodemailer 10 (PR A). No network: nodemailer.createTransport is
// replaced before email.js builds its transporter. The send path still goes through
// nodemailer's real message builder (jsonTransport), so the upgraded library is exercised;
// verify() uses a fake transport with controllable results.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const nodemailer = require('nodemailer');

const EMAIL_PATH = require.resolve('../src/lib/email');
const realCreateTransport = nodemailer.createTransport;
const SES = { SES_SMTP_HOST: 'smtp.example.test', SES_SMTP_USER: 'user', SES_SMTP_PASS: 'pass', SES_FROM_EMAIL: 'noreply@example.test' };

function freshEmail() {
  delete require.cache[EMAIL_PATH];
  return require(EMAIL_PATH);
}

describe('lib/email — nodemailer 10, no network', () => {
  const saved = {};
  let createdWith;

  beforeEach(() => {
    for (const k of Object.keys(SES)) { saved[k] = process.env[k]; process.env[k] = SES[k]; }
    createdWith = null;
  });

  afterEach(() => {
    nodemailer.createTransport = realCreateTransport;
    for (const k of Object.keys(SES)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    delete require.cache[EMAIL_PATH];
  });

  it('sends through the SMTP transport config, wrapped in the layout, with the subject suffix', async () => {
    const sent = [];
    nodemailer.createTransport = (opts) => {
      createdWith = opts;
      const t = realCreateTransport({ jsonTransport: true });
      const sendMail = t.sendMail.bind(t);
      t.sendMail = async (msg) => { const info = await sendMail(msg); sent.push(JSON.parse(info.message)); return info; };
      return t;
    };
    const email = freshEmail();
    const ok = await email.sendEmail('a@example.test', 'Hello', `<p>${email.escHtml('<b>x</b> & "y"')}</p>`);
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(
      { host: createdWith.host, port: createdWith.port, secure: createdWith.secure, pool: createdWith.pool, user: createdWith.auth.user },
      { host: 'smtp.example.test', port: 465, secure: true, pool: true, user: 'user' }
    );
    assert.strictEqual(sent.length, 1);
    const m = sent[0];
    assert.strictEqual(m.subject, 'Hello — Kodspot');
    assert.deepStrictEqual(m.to.map((t) => t.address), ['a@example.test']);
    assert.strictEqual(m.from.address, 'noreply@example.test');
    assert.match(m.html, /<div class="hdr">Kodspot<\/div>/);
    assert.match(m.html, /&lt;b&gt;x&lt;\/b&gt; &amp; &quot;y&quot;/, 'body content is escaped by escHtml');
  });

  it('a send failure returns false and never throws', async () => {
    nodemailer.createTransport = () => ({ sendMail: async () => { throw Object.assign(new Error('boom'), { code: 'ECONNECTION' }); } });
    const email = freshEmail();
    assert.strictEqual(await email.sendEmail('a@example.test', 'x', 'y'), false);
  });

  it('without SES_* configured: no transport, sendEmail false, verify reports not configured', async () => {
    delete process.env.SES_SMTP_HOST;
    nodemailer.createTransport = () => { throw new Error('must not be called'); };
    const email = freshEmail();
    assert.strictEqual(email.getSesTransporter(), null);
    assert.strictEqual(await email.sendEmail('a@example.test', 'x', 'y'), false);
    assert.deepStrictEqual(await email.verifyTransport(), { configured: false });
  });

  it('verifyTransport: ok when verify() resolves, the error code when it rejects', async () => {
    let fail = false;
    nodemailer.createTransport = () => ({
      verify: async () => { if (fail) throw Object.assign(new Error('auth failed for user'), { code: 'EAUTH' }); return true; }
    });
    const email = freshEmail();
    assert.deepStrictEqual(await email.verifyTransport(), { configured: true, ok: true });
    fail = true;
    const res = await email.verifyTransport();
    assert.deepStrictEqual(res, { configured: true, ok: false, code: 'EAUTH' });
    assert.ok(!JSON.stringify(res).includes('user'), 'only the error code is reported');
  });

  it('the transporter is built once and reused', async () => {
    let builds = 0;
    nodemailer.createTransport = () => { builds++; return { sendMail: async () => ({}) }; };
    const email = freshEmail();
    await email.sendEmail('a@example.test', 'x', 'y');
    await email.sendEmail('b@example.test', 'x', 'y');
    assert.strictEqual(builds, 1);
  });
});
