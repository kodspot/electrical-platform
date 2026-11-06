export const meta = {
  name: 'product-audit',
  description: 'Read-only audit of security, DPDP and future-readiness: focused finders, adversarial verification, coverage critic, triage; stops cleanly at a usage limit',
  phases: [
    { title: 'Find', detail: 'thirteen focused auditors, four at a time' },
    { title: 'Verify', detail: 'a skeptic per dimension, plus an independent skeptic per critical or high finding' },
    { title: 'Coverage', detail: 'a critic looks for what was not examined; gaps get one more round' },
    { title: 'Triage', detail: 'fix now, owner decision, roadmap, deferred' },
  ],
}

// Args: { today: 'YYYY-MM-DD', scope?: 'security' | 'dpdp' | 'future' }. See docs/AUDIT_PLAYBOOK.md.
const TODAY = args && args.today
const SCOPE = args && args.scope
if (!TODAY) throw new Error('pass args.today, YYYY-MM-DD')
const REPO = 'the current working directory'

const FRUGAL = `Working frugally is a hard requirement: an earlier job on this account was stopped by its usage limit because agents loaded too much into context. Read only the files in your scope. Use Grep to find things across the code, then Read only the lines you need. Send several Read calls in one message. Never re-read a file. Do not read test files unless a finding depends on them. Stop when your scope is covered.`

const CONTEXT = `You are auditing Kodspot Electrical, a live multi-tenant SaaS (Fastify 5, Prisma 5, PostgreSQL, vanilla-JS pages) for electrical inspections and facility tickets in Indian hostels and colleges. Roles: guest (residents, no account), electrician (worker), supervisor, admin, super-admin. It runs as one Docker host on AWS EC2 with Caddy, Cloudflare R2 for images and backups, Amazon SES for email, and an optional AI provider. The GitHub repository and its Actions logs are public. A real hostel is about to go live on it.
Repository: ${REPO}. This audit is read-only: never edit, create or delete anything in the repository, and never run commands that change state.
Today is ${TODAY}.

${FRUGAL}

Rules of evidence: every finding needs the exact file:line and a concrete failure or attack scenario. No theoretical findings without a real path in this code. Severity: critical = likely, severe harm to many people or tenants' data now; high = a real exploit or data-loss path, or a clear legal breach once in force; medium = a real weakness with limits; low = hardening.

Do not re-report these known open items unless you have new evidence of something worse; list them only in "alreadyKnown" if relevant:
- Owner decisions pending: super-admin single shared key without MFA (PAR-10/02); no per-account login lockout (10); per-IP complaint limits shared on hostel Wi-Fi (11); org purge after deletion (17); per-session server sign-out, 30-day electrician tokens (49); stop collecting Aadhaar or keep it (decision D-3).
- Accepted for now: CSP has 'unsafe-inline' (35); single instance (41); scheduler lock held in a 5-minute transaction (47).
- Deferred by the owner, never recommend or audit: Telegram or webhook alert channels, ticket SLA timers and escalation, iPhone camera QR fallback. Record them as "deferred by the owner" at most.
Already fixed in BUG-0027 to BUG-0060 (see CHANGELOG.md, section 2026-10-25), so check that a suspected issue is not one of those before reporting it. The earlier review is docs/history/product-architecture-review-2026-10.md: grep it for a topic rather than reading it.`

const FINDINGS = { type: 'object', properties: {
  covered: { type: 'string' },
  notCovered: { type: 'string' },
  alreadyKnown: { type: 'array', items: { type: 'string' } },
  findings: { type: 'array', items: { type: 'object', properties: {
    title: { type: 'string' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    evidence: { type: 'string' },
    scenario: { type: 'string' },
    standard: { type: 'string' },
    fix: { type: 'string' },
    effort: { type: 'string', enum: ['small', 'medium', 'large'] },
    needsOwnerDecision: { type: 'boolean' },
    decisionWhy: { type: 'string' },
    needsMigration: { type: 'boolean' },
  }, required: ['title', 'severity', 'evidence', 'scenario', 'standard', 'fix', 'effort', 'needsOwnerDecision', 'decisionWhy', 'needsMigration'] } },
}, required: ['covered', 'notCovered', 'alreadyKnown', 'findings'] }

const VERDICTS = { type: 'object', properties: {
  verdicts: { type: 'array', items: { type: 'object', properties: {
    index: { type: 'number' },
    verdict: { type: 'string', enum: ['confirmed', 'downgraded', 'refuted'] },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    reason: { type: 'string' },
  }, required: ['index', 'verdict', 'severity', 'reason'] } },
}, required: ['verdicts'] }

const SKEPTIC = { type: 'object', properties: {
  refuted: { type: 'boolean' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, reason: { type: 'string' },
}, required: ['refuted', 'severity', 'reason'] }

const CRITIC = { type: 'object', properties: {
  gaps: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, scope: { type: 'string' }, ask: { type: 'string' } }, required: ['key', 'scope', 'ask'] } },
  note: { type: 'string' },
}, required: ['gaps', 'note'] }

const GROUPED = { type: 'object', properties: { title: { type: 'string' }, severity: { type: 'string' }, dimension: { type: 'string' }, evidence: { type: 'string' }, scenario: { type: 'string' }, standard: { type: 'string' }, fix: { type: 'string' } }, required: ['title', 'severity', 'dimension', 'evidence', 'scenario', 'standard', 'fix'] }
const TRIAGE = { type: 'object', properties: {
  fixNow: { type: 'array', items: { type: 'object', properties: {
    group: { type: 'string' }, why: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, migration: { type: 'boolean' }, testIdea: { type: 'string' },
    items: { type: 'array', items: GROUPED },
  }, required: ['group', 'why', 'files', 'migration', 'testIdea', 'items'] } },
  ownerDecisions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, why: { type: 'string' }, options: { type: 'string' }, recommendation: { type: 'string' }, blocksGoLive: { type: 'boolean' }, related: { type: 'string' } }, required: ['question', 'why', 'options', 'recommendation', 'blocksGoLive', 'related'] } },
  roadmap: { type: 'array', items: GROUPED },
  dropped: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, reason: { type: 'string' } }, required: ['title', 'reason'] } },
  scorecard: { type: 'object', properties: { security: { type: 'string' }, dpdp: { type: 'string' }, futureReadiness: { type: 'string' }, goLive: { type: 'string' } }, required: ['security', 'dpdp', 'futureReadiness', 'goLive'] },
}, required: ['fixNow', 'ownerDecisions', 'roadmap', 'dropped', 'scorecard'] }

const stopped = (where, extra) => { log(`Stopped at ${where}: an agent did not return (usage limit or error). Resume this run to continue.`); return { stopped: where, ...extra } }
async function batched(items, size, fn) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(...(await parallel(items.slice(i, i + size).map((x) => () => fn(x)))))
  return out
}

const LEGAL = `Legal reference: read docs/reference/dpdp-requirements.md once. It holds the Act's primary text, plus labelled commentary on the Rules. Earlier verified sources are in docs/history/product-architecture-review-2026-10.md section 15 (grep "CERT-In", "Aadhaar", "R-0"). Label each legal statement as Act text or as commentary on the Rules, and cite the section. This is a technical gap assessment, not legal advice; where the law is unclear say so instead of guessing. The hostels are likely Data Fiduciaries or the product may be, depending on the contract: state which role you assumed, and treat Kodspot as at least a Data Processor for each customer and a Data Fiduciary for its own staff accounts, and flag this as a question for counsel.`

const DIMS = [
  { key: 'sec-auth', area: 'security', effort: 'high', prompt: `Security: authentication and sessions. Scope: apps/api/src/routes/auth.js, worker-auth.js, images.js, notifications.js, src/middleware/auth.js, src/middleware/rateLimits.js, src/lib/security.js, src/config/env.js. Standard: OWASP ASVS 4.0 level 2 (V2, V3), OWASP API Top 10 2023 (API2). Check: token issue, lifetime and revocation paths for each role; deactivated accounts and suspended orgs on every auth path including streams and image tokens; tokens in URLs; /auth/login-qr; password and PIN policy and hashing; reset flows; user enumeration by status or timing; the bootstrap path; what happens to sessions on role or org change.` },
  { key: 'sec-tenancy-1', area: 'security', effort: 'high', prompt: `Security: authorization and tenant isolation, part 1. Scope: every handler in apps/api/src/routes/tickets.js, workers.js, supervisors.js, locations.js, assets.js, asset-events.js, asset-failures.js, electrical.js, and src/middleware/auth.js as reference. Standard: OWASP API Top 10 2023 API1 (BOLA), API3 (property level), API5 (function level). For each route check: the policy and module gate; every tenant-owned query filters by server-derived orgId; ids in the body or query (locationId, workerId, assignedToId, assetId, templateId) are checked to belong to the org; mutations by bare id are preceded by an org check; another org's record answers 404; responses do not expose secrets or more personal data than the role needs; mass assignment.` },
  { key: 'sec-tenancy-2', area: 'security', effort: 'high', prompt: `Security: authorization and tenant isolation, part 2. Scope: every handler in apps/api/src/routes/attendance.js, duty-roster.js, alerts.js, analytics.js, audit-logs.js, templates.js, complaint-categories.js, notifications.js, ai.js, predictions.js. Same checks as OWASP API1, API3, API5: gate, orgId on every query, ids in the body checked against the org, 404 for another org, no excess personal data in responses, and supervisors limited to what the role should see (for example Aadhaar, or other supervisors' data).` },
  { key: 'sec-tenancy-3', area: 'security', effort: 'high', prompt: `Security: authorization and privileged or public surfaces. Scope: apps/api/src/routes/superadmin.js, superadmin-qa.js, qa.js, public.js, pages.js, health.js, images.js. Check super-admin org entry (X-Org-Id) and its audit; every SUPER_ADMIN route's gate; the QA ingest token path; /health/info disclosure to anonymous callers; public complaint and review routes, including review-token entropy, expiry, single use, and what a token reveals; the image proxy's access rule across orgs; page routes for suspended orgs.` },
  { key: 'sec-input', area: 'security', effort: 'high', prompt: `Security: input handling and injection across apps/api/src. Use Grep to sweep, then read only the hits. Check: $queryRaw, $executeRaw and any *Unsafe; file upload validation, size limits and storage paths (lib/r2.js including the local driver); path traversal in the image proxy; CSV exports and formula injection (attendance, assets, asset failures, electrical); HTML email templates and escHtml coverage (lib/email.js and callers); PDF or print output; SSRF in outbound calls (AI provider base URLs, GitHub, webhooks); prototype pollution; ReDoS in hand-written regexes; missing limits on pagination and bulk arrays (limit, page, ids); query parameters that may arrive as arrays; JSON fields stored and later rendered; log injection. zod was upgraded from 3 to 4 recently, so look for validation behaviour that may have changed.` },
  { key: 'sec-infra', area: 'security', effort: 'high', prompt: `Security: infrastructure and supply chain. Scope: apps/api/Dockerfile, docker-compose.yml, infrastructure/ (Caddyfile, backup and restore scripts), apps/api/src/plugins/*.js (helmet, CSP, CORS, cookies), .github/workflows/*.yml, .github/audit-exceptions.json, .env.example, .gitignore, and git history only by grep for secrets. Check: container user and capabilities, exposed ports, DB exposure, image pinning; TLS and headers; CORS; cookies; GitHub Actions permissions, third-party action pinning, secret handling (including the deploy step that writes .env), PR trigger safety on a public repository, the workflow_dispatch token scope; backup encryption, retention and access; whether logs can carry personal data or credentials (lib/log-redaction.js).` },
  { key: 'sec-abuse', area: 'security', effort: 'high', prompt: `Security: business-logic abuse. Scope: apps/api/src/routes/public.js, ai.js, src/services/automation.js, notification-service.js, lib/email.js, lib/ai-provider.js. Think like an attacker with no account, then like a malicious resident, a malicious electrician and a malicious supervisor. Check: complaint flooding and notification or email bombing; enumerating QR codes, org slugs and locations; reusing or guessing review links; forcing a ticket to close or reopen; prompt injection from resident text into AI features and what the AI can reach; AI spend limits; forged proof photos or actions attributed to someone else; races around quotas and limits.` },
  { key: 'dpdp-inventory', area: 'dpdp', effort: 'medium', prompt: `DPDP: personal data inventory. ${LEGAL}
Read apps/api/prisma/schema.prisma and build a complete inventory of personal data: every field that identifies or relates to a person, per model, per kind of person (resident or guest, electrician, supervisor, admin, super admin, and possibly minors). For each: purpose, lawful basis assumed, who can see it, where it flows (R2, SES, AI provider, logs, audit rows, backups, emails, browser storage, service-worker cache), retention today, and encryption. Write this inventory as a Markdown document to docs/reference/personal-data-inventory.md (that scratch file is the one thing you may write). Then report as findings any field that is collected without a clear purpose, any flow the privacy page does not mention, and any personal data found in unexpected places such as logs, notifications, audit rows or client storage.` },
  { key: 'dpdp-notice-rights', area: 'dpdp', effort: 'medium', prompt: `DPDP: notice, consent, children and rights. ${LEGAL}
Scope: apps/api/public/privacy.html and terms.html, apps/api/public/scan.html and review.html, apps/api/src/routes/public.js for what is collected, and the export route in apps/api/src/routes/auth.js. Check, section by section of the Act: section 5 notice, section 6 consent and withdrawal, section 7 legitimate uses for staff data, section 9 children (hostel residents and students may be under 18: what does the product do, and what does the likely Fourth Schedule exemption cover and not cover), sections 11 to 14 access, correction, erasure, grievance, nomination for each kind of person, and section 8(9) and (10) contact and grievance. Quote every statement in privacy.html or terms.html that the code contradicts, with the code that contradicts it: these are defects even before the law's dates. List what a resident, an electrician and a supervisor can actually do today to use each right.` },
  { key: 'dpdp-retention-safeguards', area: 'dpdp', effort: 'medium', prompt: `DPDP: retention, erasure, safeguards and breach. ${LEGAL}
Scope: apps/api/src/services/cleanup.js, scripts/migrate-user-pii.js, src/lib/crypto.js, lib/log-redaction.js, the logging setup, infrastructure backup scripts, docs/DISASTER_RECOVERY.md, docs/MONITORING.md. Check section 8(4) to 8(8) of the Act and the commentary on Rules 6, 7 and 8. Map each kind of personal data to its actual retention, including backups and logs. In particular analyse the reported one-year minimum retention of personal data, traffic data and logs for all fiduciaries (Rule 8, commentary) against the 180-day guest anonymisation, the 30-day photo deletion and the 14-day backups, and state clearly what conflicts and what counsel must confirm. Check whether access logs that the Rules are said to require exist and are kept a year. Check for a breach response procedure: who detects, who decides, who tells whom, by when (Board, Data Principals, CERT-In), and what templates exist. Check processor arrangements (AWS, Cloudflare, SES, AI provider) and cross-border flows under section 16.` },
  { key: 'future-architecture', area: 'future', effort: 'medium', prompt: `Future readiness: architecture and scale. Scope: apps/api/index.js, src/services, src/lib/prisma.js, src/middleware/rateLimits.js, prisma/schema.prisma (indexes), docs/SCALING.md, docs/architecture/overview.md, and Grep across routes for findMany calls without take, N+1 patterns and in-memory aggregation. Ask what breaks first at 10, 100 and 1000 hostels: unbounded queries, missing indexes on real filter columns, analytics that load all rows, SSE on one process, in-memory rate limits, image growth in R2, job duration against the scheduler lock, connection pool. Give a measurable trigger for each change. Prefer the modular monolith on one PostgreSQL (ADR 0002): do not propose a new service, queue or Redis unless a trigger justifies it.` },
  { key: 'future-maintainability', area: 'future', effort: 'medium', prompt: `Future readiness: maintainability and upgrade path. Scope: apps/api/package.json, package-lock.json at a glance, e2e/package.json, Node and Postgres versions in Dockerfile and compose, docs/ENGINEERING_CHARTER.md headings, docs/README.md, CLAUDE.md. You may run read-only commands: npm outdated (in apps/api), and node scripts/check-routes-drift.js. Check support end dates of Node, PostgreSQL, Prisma, Fastify and other key dependencies (say which you could verify today and how); how far behind each is; duplicated logic that should be one function (Grep for repeated patterns such as CSV building, date handling, photo upload, pagination, the three login handlers); hardcoded module lists; test-suite weaknesses such as tests that race or depend on wall-clock time (two were found recently: a notification race and UTC 'today' in scenarios); documentation that has drifted from code.` },
  { key: 'future-operations', area: 'future', effort: 'medium', prompt: `Future readiness: operations. Scope: docs/DEPLOYMENT.md, docs/DISASTER_RECOVERY.md, docs/MONITORING.md, infrastructure/, .github/workflows/deploy.yml and deploy-staging.yml, docker-compose.yml. Assume one person runs this for many hostels. Check: deploy downtime and rollback (is there a tested way back?); restore tested at what scale; what happens when the disk fills, when R2 credentials expire, when SES is suspended, when the certificate fails; log rotation; runbooks for the likely incidents; onboarding steps for a new hostel, whether they are documented and repeatable; staging. Alert channels are deferred by the owner: do not recommend them.` },
  { key: 'future-reliability', area: 'future', effort: 'medium', prompt: `Future readiness: reliability and data integrity. Scope: Grep apps/api/src for $transaction, updateMany, deleteMany, fire-and-forget promises (.catch(() => {})), setInterval jobs, and read the hits. Check Charter section 8.1 (multi-record writes in a transaction), lost-update races outside tickets (assets, attendance, templates, categories, supervisor and worker edits), idempotency of retried or double-submitted forms on the server, jobs that can partly apply, failures swallowed silently where the user believes something happened, foreign-key RESTRICT hazards on delete, and orphaned files in R2 when a database write fails.` },
]
const SELECTED = SCOPE ? DIMS.filter((d) => d.area === SCOPE) : DIMS

// ---------------------------------------------------------------- Find
phase('Find')
const found = await batched(SELECTED, 4, (d) => agent(`${CONTEXT}

Your dimension: ${d.prompt}

Report real findings only, most severe first. In "covered" say exactly what you examined; in "notCovered" say what in your scope you did not get to.`, { label: `find:${d.key}`, phase: 'Find', schema: FINDINGS, effort: d.effort }).then((r) => r && { key: d.key, area: d.area, ...r }))
if (found.some((r) => !r)) return stopped('find', { finished: found.filter(Boolean).map((r) => r.key) })
log(`Find: ${found.reduce((n, r) => n + r.findings.length, 0)} raw findings`)

// ---------------------------------------------------------------- Verify
phase('Verify')
async function verify(results) {
  const verified = await batched(results.filter((r) => r.findings.length), 4, (r) => agent(`${CONTEXT}

You are a skeptical senior engineer. Below are findings from another auditor (dimension ${r.key}), numbered by index. Try to refute each one: open the exact code cited, follow the real path, check for guards the auditor missed (middleware, hooks, encapsulated plugins, schema constraints, earlier checks). Default to "refuted" if you cannot find the evidence in the code. "downgraded" means real but less severe; give the corrected severity. For legal findings, check the Act text in docs/reference/dpdp-requirements.md only where needed.

Findings:
${JSON.stringify(r.findings.map((f, index) => ({ index, title: f.title, severity: f.severity, evidence: f.evidence, scenario: f.scenario })), null, 1)}`, { label: `verify:${r.key}`, phase: 'Verify', schema: VERDICTS, effort: 'medium' }).then((v) => {
    if (!v) return null
    return r.findings.map((f, i) => { const x = v.verdicts.find((y) => y.index === i); return { ...f, dimension: r.key, area: r.area, verdict: x ? x.verdict : 'unverified', severity: x && x.verdict !== 'refuted' ? x.severity : f.severity, verifyNote: x ? x.reason : 'no verdict returned' } })
  }))
  if (verified.some((v) => !v)) return null
  const kept = verified.flat().filter((f) => f.verdict !== 'refuted')
  const serious = kept.filter((f) => f.severity === 'critical' || f.severity === 'high')
  const second = await batched(serious, 4, (f) => agent(`${CONTEXT}

Independent second opinion. Assume this finding is wrong and try hard to prove it. Read the cited code and whatever guards it. Only say refuted=false if you can trace the real failure yourself. Give the severity you would defend.

${JSON.stringify({ title: f.title, severity: f.severity, evidence: f.evidence, scenario: f.scenario, firstVerifier: f.verifyNote }, null, 1)}`, { label: `skeptic:${f.dimension}`, phase: 'Verify', schema: SKEPTIC, effort: 'high' }).then((s) => s && { f, s }))
  if (second.some((x) => !x)) return null
  const refuted = new Set(second.filter((x) => x.s.refuted).map((x) => x.f))
  second.filter((x) => !x.s.refuted).forEach((x) => { x.f.severity = x.s.severity; x.f.secondOpinion = x.s.reason })
  return { kept: kept.filter((f) => !refuted.has(f)), dropped: [...verified.flat().filter((f) => f.verdict === 'refuted'), ...refuted] }
}
const round1 = await verify(found)
if (!round1) return stopped('verify', { found })
log(`Verify: ${round1.kept.length} confirmed, ${round1.dropped.length} refuted`)

// ---------------------------------------------------------------- Coverage
phase('Coverage')
const critic = await agent(`${CONTEXT}

Below is what each auditor says it covered and did not cover, and the titles of confirmed findings. Be the completeness critic: which server-side area, data flow, standard or scenario relevant to a hostel go-live has nobody examined? Client-side pages are audited separately later, so leave those out. Name at most three gaps worth one more focused look, each as a key, the exact files in scope, and what to ask. If coverage is good, return no gaps.

${JSON.stringify(found.map((r) => ({ key: r.key, covered: r.covered, notCovered: r.notCovered })), null, 1)}

Confirmed titles: ${JSON.stringify(round1.kept.map((f) => f.title))}`, { label: 'critic', phase: 'Coverage', schema: CRITIC, effort: 'medium' })
if (!critic) return stopped('coverage', { kept: round1.kept })
let kept = round1.kept, dropped = round1.dropped, extra = []
if (critic.gaps.length) {
  extra = await batched(critic.gaps, 3, (g) => agent(`${CONTEXT}

A focused extra look. Scope: ${g.scope}. Question: ${g.ask}
Report real findings only. Do not repeat these titles: ${JSON.stringify(kept.map((f) => f.title))}`, { label: `find:${g.key}`, phase: 'Coverage', schema: FINDINGS, effort: 'medium' }).then((r) => r && { key: g.key, area: 'gap', ...r }))
  if (extra.some((r) => !r)) return stopped('coverage-find', { kept })
  const round2 = await verify(extra)
  if (!round2) return stopped('coverage-verify', { kept })
  kept = kept.concat(round2.kept); dropped = dropped.concat(round2.dropped)
}

// ---------------------------------------------------------------- Triage
phase('Triage')
const triage = await agent(`${CONTEXT}

You are the lead auditor. Below are all verified findings, as JSON. Merge duplicates and sort everything into:
- fixNow: real defects with a clear correct behaviour that need no business or legal decision and no destructive data change. Group them so that each group is one coherent change for one engineer, smallest safe change first, with the files involved, whether a schema migration is needed (additive only; avoid one if you can), and how to prove it with a failing test first. Highest severity groups first.
- ownerDecisions: anything that needs a business, legal or material security trade-off decision. Give the question in plain English, why it matters, the options, your recommendation, whether it blocks the first hostel going live, and the related PAR-10 or D-n reference.
- roadmap: real but large, or triggered by scale; give the trigger in the fix field.
- dropped: only duplicates and non-issues, with the reason.
Never recommend the owner-deferred items. Then write a scorecard: one honest paragraph each for security, dpdp and futureReadiness, and goLive: can the first hostel go live, and what must happen first. Refer to the law's actual dates: the main DPDP duties are expected from about May 2027.

Findings:
${JSON.stringify(kept.map((f) => ({ title: f.title, severity: f.severity, dimension: f.dimension, evidence: f.evidence, scenario: f.scenario, standard: f.standard, fix: f.fix, effort: f.effort, needsOwnerDecision: f.needsOwnerDecision, decisionWhy: f.decisionWhy, needsMigration: f.needsMigration })))}`, { label: 'triage', phase: 'Triage', schema: TRIAGE, effort: 'high' })
if (!triage) return stopped('triage', { kept, dropped: dropped.map((f) => f.title) })

return {
  counts: { raw: found.reduce((n, r) => n + r.findings.length, 0) + extra.reduce((n, r) => n + r.findings.length, 0), confirmed: kept.length, refuted: dropped.length },
  coverage: found.concat(extra).map((r) => ({ key: r.key, covered: r.covered, notCovered: r.notCovered, alreadyKnown: r.alreadyKnown })),
  criticNote: critic.note,
  triage,
  kept,
  refuted: dropped.map((f) => ({ title: f.title, why: f.verifyNote })),
}
