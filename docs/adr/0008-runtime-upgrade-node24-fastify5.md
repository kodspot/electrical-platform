# 0008. Runtime upgrade: Node 24, Fastify 5, bcrypt 6

- **Status:** Proposed
- **Date:** 2026-10-14
- **Deciders:** owner (super-admin), engineering

## Context

The dependency audit gate ([ADR 0007](0007-dependency-audit-gate.md)) carried 16 dated
exceptions that could only be cleared by upgrades:
- **7 for the Fastify 4 chain** (`fastify`, `find-my-way`, `@fastify/static`), expiring
  2026-12-13;
- **9 for `tar`**, via bcrypt 5's install-time `node-pre-gyp`, expiring 2026-11-13.

The production image ran Node 20, whose LTS support is ending. Node 24 is the active LTS.

## Decision

| Component | Before | After |
|---|---|---|
| Node (Docker image, CI, e2e) | 20 (`node:20-alpine`) | **24** (`node:24-alpine`); `engines: >=24` |
| fastify | 4.29.1 | **5.12.5** |
| @fastify/cookie | 9.x | 11.1.2 |
| @fastify/cors | 9.x | 11.3.0 |
| @fastify/helmet | 11.x | 13.1.1 |
| @fastify/multipart | 8.x | 10.1.2 |
| @fastify/rate-limit | 9.x | 11.2.0 |
| @fastify/static | 6.12.0 | 10.1.5 |
| bcrypt | 5.1.1 | **6.0.0** (no `node-pre-gyp`/`tar`) |

**Version choice:** each is the newest release published at least 14 days before the change
(the supply-chain rule), and each clears every advisory: the runtime `npm audit` shows 0, and
`.github/audit-exceptions.json` is empty.

**CI:**
- **Node 22:** a report-only "Lint & Test (Node 22)" job runs for one release. It never
  blocks.
- **Image smoke test:** the "Lint & Test" job builds the production image, starts it
  (`NODE_ENV=production`) against a fresh CI database, lets it apply every migration,
  requires `/health/ready` = 200, bootstraps the super-admin and signs in by email and
  password (bcrypt inside the Alpine image), then stops it.

### Fastify 5 breaking changes (official migration guide), one by one

| # | Change | Applies here? | Where / fix |
|---|---|---|---|
| 1 | Node 20+ required | — | moving to 24 |
| 2 | Full JSON Schema required for querystring/params/body/response | no | no route declares a Fastify schema (validation is zod in handlers) |
| 3 | `logger` no longer takes an instance (`loggerInstance`) | no | `index.js` passes pino *options* (`resolveLoggerOptions`). The redaction serializers still merge (`test/log-redaction*.test.js` green) |
| 4 | `useSemicolonDelimiter` false by default | no | no `;`-delimited query strings |
| 5 | `request.params` has no prototype | no | params are read by property only |
| 6 | Type providers split validator/serializer | no | TypeScript only |
| 7 | `.listen()` object form only | no | `index.js:165` already uses `{ port, host }` |
| 8 | Direct return of trailers removed | no | no trailers |
| 9 | Route data only via `request.routeOptions` | no | `lib/log-redaction.js:23` (logs, alerts) already uses `routeOptions.url`; no `routerPath`/`context` |
| 10 | **`reply.redirect(url, code)`** | **yes** | `routes/pages.js:214`, the legacy `/{org}/{page}` → `/{org}/ele/{page}` redirect. The v4 order returned a **500** under v5 (red test), fixed to `redirect(url, 301)` |
| 11 | Modifying `reply.sent` forbidden | no | not used |
| 12 | Route-versioning constraint signature | no | not used |
| 13 | HEAD before GET with `exposeHeadRoutes` | no | no explicit HEAD routes |
| 14 | `request.connection` removed | no | not used (`request.socket` / `request.ip`) |
| 15 | `reply.getResponseTime()` removed | no | `plugins/observability.js:33` already uses `reply.elapsedTime` |
| 16 | `hasRoute()` matches find-my-way | no | not used |
| 17 | Non-standard HTTP methods removed | no | standard methods only |
| 18 | Reference types in decorators removed | no | no `decorateRequest`/`decorateReply` with objects |
| 19 | **DELETE with `Content-Type: application/json` and an empty body rejected** | **would** | All 9 browser DELETE call sites send exactly that. Our F14 parser (`plugins/content.js`) reads an empty JSON body as `{}`, so they still reach their routes. 9 new tests, one per call site |
| 20 | Plugins can't mix callback and promise | no | every plugin and route module is `async`, none takes `done` |
| 21 | **`request.hostname` drops the port** (`request.host`, `request.port` added) | yes, harmless | `lib/log-redaction.js:48` logs `hostname`, which now has no port. Test added |
| 22 | `time`/`date-time` formats enforce a timezone | no | JSON-schema formats only; none used |

### Other areas checked explicitly (tests that prove each)

- **Log redaction:** the serializer merge and `routeOptions` in logs and alerts are proven
  by `log-redaction` (unit + app).
- **F14 JSON parser:** `empty-json-body` (24 cases) plus the 9 new DELETE cases.
- **`trustProxy` / `request.ip`:** the F15 image tests and every rate-limit test (login,
  dispatch, checks).
- **`reply.sendFile` / static:** `reset-pages`, the page routes, and e2e.
- **Multipart `toBuffer` and limits:** `upload-validation` (400, 400, 413) and the e2e photo
  uploads (J2, J4).
- **Rate-limit `keyGenerator`/config:** `qa-dispatch` (one per 10 min), `qa-dashboard`
  (checks, one per 30 s), the login tests.
- **`setErrorHandler` / `setNotFoundHandler`:** the error/404 tests and the circuit-breaker
  503 mapping.
- **SSE raw writes:** a new real-socket test covers event-stream headers, the `connected`
  event, a pushed event, and cleanup on close.
- **`inject()`:** the whole suite runs through it unchanged.

### Plugin majors

- `@fastify/cors` 10+ narrowed the default `methods`. Ours are explicit (`plugins/security.js`).
- `@fastify/helmet` 12+ uses Helmet 8: HSTS defaults to 365 days (production HSTS is set by
  Caddy, 2 years), and CSP directives must be quoted (ours are).
- The rest pass the suite unchanged.

### bcrypt 6

Stored hashes are `$2b$`.
- `test/bcrypt-compat.test.js` verifies three hashes produced by bcrypt **5.1.1** before the
  upgrade (cost 10 and 12, including a Unicode password) under bcrypt 6, and confirms that
  wrong secrets are refused.
- `test/integration/bcrypt-compat-login.test.js` signs in through the API with a
  bcrypt-5-era stored hash.

## Alternatives considered

- **Renew the exceptions and stay on Fastify 4 and Node 20.** This postpones the work: the
  same advisories keep coming back, and Node 20 leaves LTS.
- **Node 22 instead of 24.** It works (the report-only job proves it), but 24 is the
  current LTS with the longer support window.

## Consequences

- **The runtime audit is clean, with 0 exceptions.** Any new high/critical advisory fails CI
  again.
- **Logs:** `request.hostname` in logs no longer shows the port.
- **No data change:** no migration and no change to stored hashes.
- **Rollback = revert the PR** (lockfile, Dockerfile and code together), then deploy.
  Nothing in the database depends on the new versions.

## Related

- [ADR 0007](0007-dependency-audit-gate.md): the audit gate whose exceptions this clears.
- The Fastify v5 migration guide (`fastify/docs/Guides/Migration-Guide-V5.md`).
- `CHANGELOG.md`, 2026-10-14 (runtime).
