# Architecture Overview

How the Kodspot Electrical Platform is put together, and why. This is the map; the other
`docs/architecture/` documents zoom into each area. It explains structure and intent — it
does not restate code. Paths like `apps/api/src/index.js:85` link to the implementation.

## What it is

A **multi-tenant SaaS** for electrical-inspection and facility-ticket management. One
deployment serves many organizations (tenants); every organization's data is isolated by
an `orgId` carried on nearly every row (see [auth-and-tenancy.md](auth-and-tenancy.md)).
Business capability is divided into **modules** (`ele`, `civil`, `asset`, `complaints`)
that an organization can have selectively enabled (see [module-system.md](module-system.md)).

Five human roles, in increasing privilege: **guest** (unauthenticated public complainant)
→ **electrician/worker** → **supervisor** → **admin** → **super-admin** (cross-tenant
operator).

## Shape: a modular monolith

This is a deliberate **modular monolith**, not microservices — one Node process, one
database, internal boundaries enforced by module structure rather than network calls. The
Engineering Charter (§5) treats any move away from this (a job queue, an event bus, Redis,
a second service) as an architecture decision requiring an ADR, not a per-PR choice. Read
the Charter §5 before proposing structural change.

## The stack

| Layer | Technology | Notes |
|---|---|---|
| HTTP / API | **Fastify 4** | `apps/api/index.js` assembles it; `trustProxy`, 30s request timeout |
| ORM / DB | **Prisma 5 → PostgreSQL 15** | single shared client, `apps/api/src/lib/prisma.js` |
| Frontend | **Server-rendered static HTML + vanilla JS PWA** | `apps/api/public/`; see [frontend.md](frontend.md) |
| Reverse proxy / TLS | **Caddy** | `infrastructure/Caddyfile`, automatic HTTPS |
| Object storage | **Cloudflare R2** (S3 API) | images + offsite backups, `apps/api/src/lib/r2.js` |
| Email | **SES over SMTP (nodemailer)** | optional, `apps/api/src/lib/email.js` |
| AI | **Azure OpenAI / Gemini** | optional per-org, `apps/api/src/lib/ai-provider.js` |
| Runtime | **Node 20 in Docker** | `apps/api/Dockerfile`, non-root |

The three runtime services (`db`, `api`, `caddy`) are defined in `docker-compose.yml`. See
[operations](../README.md#operations--run-recover-scale) for how it deploys.

## Backend structure (`apps/api/src/`)

The code is layered by responsibility, not by feature:

- **`config/`** — `env.js` loads and *validates* environment at boot (fails fast on
  missing/weak secrets; see [reference/environment.md](../reference/environment.md)).
- **`plugins/`** — cross-cutting Fastify registrations: `security.js` (CORS, Helmet/CSP,
  rate limit, cookies) and `content.js` (multipart uploads, static file serving).
- **`middleware/`** — `auth.js` (authN + the `requirePolicy`/`requireModule` guards),
  `tenant-context.js` (derives the trusted `orgId`), `permission-policy.js` (the role
  matrix), `rateLimits.js`.
- **`routes/`** — 25 route files, one per resource/concern, all registered under `/api`
  except `pages.js` (which serves the HTML app). See
  [reference/routes.generated.md](../reference/routes.generated.md) for the full endpoint
  index.
- **`services/`** — business logic reused across routes or run on a schedule (automation,
  cleanup, predictions, notifications, module registry, assignment resolution, shift
  config). The Charter extracts to a service only on a *second* call site or a scheduled
  need, not preemptively.
- **`lib/`** — infrastructure primitives: `prisma`, `crypto` (PII encryption),
  `circuit-breaker`, `scheduler-lock`, `ai-provider`, `email`, `r2`, `security`.

## Request lifecycle

For an authenticated API request (`apps/api/index.js:85` `registerApp`):

1. **Caddy** terminates TLS, forwards to the `api` container with `X-Forwarded-*` headers
   (`trustProxy: true` makes Fastify honor them for the real client IP).
2. **Security plugins** run: CORS, Helmet (CSP/HSTS), rate limiting, cookie parsing.
3. **Route-level `preHandler`s** run in order: `authenticateJWT` (verifies the token,
   loads the user, re-checks `isActive` and org `ACTIVE` status on *every* request, attaches
   the trusted tenant context), then a `requirePolicy(...)` / `requireModule(...)` guard.
   See [auth-and-tenancy.md](auth-and-tenancy.md).
4. **The handler** runs its queries through the shared `prisma` client — which routes every
   operation through the database circuit breaker automatically (see [resilience.md](resilience.md)).
5. **Response** serialized by Fastify; errors funnel through the global error handler
   (`apps/api/src/errors.js`) which logs and can alert.

The app is assembled in two halves on purpose: `buildApp()` constructs the Fastify
instance and `registerApp()` wires plugins/routes, *without* connecting to the DB or
listening — so the test suite can exercise the whole HTTP stack in-memory. `start()` adds
DB connection (with retry), module-registry seeding, schedulers, and the listener.

## Background work

Two in-process schedulers start after boot (`apps/api/index.js`): `startCleanupScheduler`
(image retention, guest-PII anonymization, template seeding) and `startAutomationScheduler`
(alert evaluation, escalation, daily AI insights). Both are `setInterval`-based and guarded
by PostgreSQL advisory locks so they stay correct if more than one instance ever runs. See
[resilience.md](resilience.md).

## Related

- [auth-and-tenancy.md](auth-and-tenancy.md) · [data-model.md](data-model.md) ·
  [module-system.md](module-system.md) · [resilience.md](resilience.md) ·
  [frontend.md](frontend.md)
- Rules that govern changes here: [`../ENGINEERING_CHARTER.md`](../ENGINEERING_CHARTER.md)
