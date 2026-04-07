'use strict';

const nodemailer = require('nodemailer');

let sesTransporter = null;

function getSesTransporter() {
  if (sesTransporter) return sesTransporter;
  const host = process.env.SES_SMTP_HOST;
  const user = process.env.SES_SMTP_USER;
  const pass = process.env.SES_SMTP_PASS;
  if (!host || !user || !pass) return null;

  sesTransporter = nodemailer.createTransport({
    host,
    port: 465,
    secure: true,
    auth: { user, pass },
    pool: true,
    maxConnections: 3,
    maxMessages: 100
  });
  return sesTransporter;
}

const SES_FROM = process.env.SES_FROM_EMAIL || 'noreply@example.com';
const APP_NAME = 'Kodspot';

/** Escape a string for safe HTML insertion (prevents XSS / HTML injection in emails) */
function escHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Send an email (fire-and-forget safe).
 * Returns true on success, false on failure. Never throws.
 * @param {string} to — recipient email
 * @param {string} subject — email subject
 * @param {string} html — HTML body content (will be wrapped in layout)
 */
async function sendEmail(to, subject, html) {
  try {
    const transport = getSesTransporter();
    if (!transport) return false;

    const wrappedHtml = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;color:#1a1a1a}
.wrap{max-width:600px;margin:0 auto;padding:20px}
.card{background:#fff;border-radius:8px;padding:28px 24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.hdr{font-size:18px;font-weight:700;color:#1E40AF;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #f0f0f0}
.body{font-size:14px;line-height:1.7;color:#333}
.body p{margin:0 0 12px}
.foot{text-align:center;padding:16px 0 0;font-size:12px;color:#888}
.btn{display:inline-block;padding:10px 24px;background:#1E40AF;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px}
.label{font-weight:600;color:#555}
.val{color:#1a1a1a}
</style></head><body>
<div class="wrap"><div class="card">
<div class="hdr">${APP_NAME}</div>
<div class="body">${html}</div>
</div>
<div class="foot">${APP_NAME} · Electrical Inspection Management Platform</div>
</div></body></html>`;

    await transport.sendMail({
      from: `${APP_NAME} <${SES_FROM}>`,
      to,
      subject: `${subject} — ${APP_NAME}`,
      html: wrappedHtml
    });
    return true;
  } catch (err) {
    // Email must never break the app — log and continue
    console.error('[email] Send failed:', err.message);
    return false;
  }
}

/**
 * Notify admin emails of an org about an event.
 * Fetches active admin emails and sends to all. Fire-and-forget.
 */
async function emailAdmins(prisma, orgId, subject, html) {
  try {
    if (!getSesTransporter()) return;
    const admins = await prisma.user.findMany({
      where: { orgId, role: 'ADMIN', isActive: true },
      select: { email: true }
    });
    for (const admin of admins) {
      sendEmail(admin.email, subject, html).catch(() => {});
    }
  } catch { /* never break */ }
}

module.exports = {
  getSesTransporter,
  SES_FROM,
  escHtml,
  sendEmail,
  emailAdmins
};
