# Frontend Architecture

The frontend is **server-rendered static HTML with vanilla JavaScript**, delivered as an
installable PWA — no build step, no SPA framework. This document explains the *patterns and
contracts* that hold the ~37 pages together. It deliberately does **not** catalog the pages
(that would just restate the filesystem under `apps/api/public/`) — pages come and go; the
patterns are what matter.

The shared client library is `apps/api/public/js/app.js` (exposed as `window.App`). Treat
its public surface as a contract; don't inventory its internals.

## Sessions: role-scoped token storage {#sessions}

Four role dashboards can be open in the same browser without clobbering each other, because
each stores its session under a **separate** localStorage key:

| Role | Token key | User key |
|---|---|---|
| Admin | `token` | `user` |
| Super-admin | `sa_token` | `sa_user` |
| Supervisor | `sup_token` | `sup_user` |
| Electrician | `elec_token` | `elec_user` |

The SuperAdmin's currently-selected org is `selectedOrgId` (with `selectedOrgName`), sent as
the `X-Org-Id` header — this is the browser side of the SA cross-tenant capability described
in [auth-and-tenancy.md](auth-and-tenancy.md#the-one-cross-tenant-capability-superadmin-x-org-id).
Each role has its own fetch helper (`apiFetch`, `saHeaders`-based fetch, `supFetch`,
`elecFetch`) that attaches the correct token; a `401` clears that role's token set and
redirects to its login, without touching the others.

## API access contract

All API calls go through `App.apiFetch(path, opts)` (and its JSON variant). This one place
owns: attaching the auth header for the active role, injecting `X-Org-Id` when a SuperAdmin
has an org selected, and handling `401` centrally. New page code calls `apiFetch` rather
than using `fetch` directly, so auth and tenant-context handling stay in a single place.

## Module-scoped routing & PWA {#module-scoped-routing--pwa}

Pages are served under **org-and-module-scoped URLs**: `/:orgSlug/:mod/<page>` (e.g.
`/acme/ele/admin-dashboard`), plus static top-level pages (`/`, `/superadmin-login`,
`/privacy`, …). `routes/pages.js` validates that the org slug exists and is `ACTIVE` before
serving — a suspended org's pages stop resolving, matching the backend gate
([auth-and-tenancy.md](auth-and-tenancy.md)).

Each org+module combination gets a **dynamically generated PWA manifest and service
worker** (`/:orgSlug/:mod/manifest.json`, `/:orgSlug/:mod/sw.js`), themed per module
(`MODULE_META` in `pages.js` — name, short name, color). This is why the platform installs
as a distinct app per module rather than one generic PWA.

## Offline sync contract

Field devices (electrician/supervisor) can lose connectivity mid-task, so writes are made
durable through `apps/api/public/js/offline-sync.js` (`window.KodspotSync`), an **IndexedDB
queue** (`kodspot-sync` DB):

- `enqueue({ url, method, headers, body })` stores a pending request, **stripping the
  `Authorization` header** — so a fresh token is re-attached on replay rather than a stale
  one being persisted.
- `getAll` (oldest-first), `remove(id)`, `count()`, `clearAll()` manage the queue.
- The queue survives page reloads (unlike an in-memory retry list), which is the whole
  point on an unreliable field connection.

The security-relevant contract here: **queued requests never persist a bearer token**;
authentication is re-established at replay time.

## Static delivery & caching

Static files are served by `@fastify/static` from `public/` (`plugins/content.js`). Caddy
sets the caching policy (`infrastructure/Caddyfile`): long cache for `/css` and `/js`,
`no-store` for org-scoped admin/supervisor/superadmin pages and for every service worker and
manifest, so a client never runs a stale SW. CSP is set by Helmet in the backend
(`plugins/security.js`), not duplicated in Caddy.

## Related

- [overview.md](overview.md) · [auth-and-tenancy.md](auth-and-tenancy.md) ·
  [module-system.md](module-system.md)
- Code: `apps/api/public/js/app.js`, `offline-sync.js`, `routes/pages.js`,
  `infrastructure/Caddyfile`
