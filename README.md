# Kodspot Electrical Platform

A multi-tenant SaaS for electrical-inspection and facility-ticket management: QR-based
location scanning, inspection checklists, ticket lifecycle management (guest complaints
through resolution and verification), attendance/duty rosters, asset tracking, and
AI-assisted analytics — serving guest, electrician, supervisor, admin, and superadmin
roles.

## Repository layout

- **`apps/api/`** — the Fastify + Prisma/PostgreSQL backend (API, server-rendered admin
  pages, and the electrician/supervisor PWA front ends under `apps/api/public/`). See
  [`apps/api/README.md`](apps/api/README.md) for local development, tests, and linting.
- **`docs/`** — the engineering knowledge base. Start at
  [`docs/README.md`](docs/README.md), the documentation index that maps every doc by
  purpose (governance, architecture, reference, operations, decisions & history). The
  governing rules live in [`docs/ENGINEERING_CHARTER.md`](docs/ENGINEERING_CHARTER.md).
- **`infrastructure/`** — VM provisioning and backup scripts used by the deploy pipeline.
- **`docker-compose.yml`** — the three services that make up a running deployment: `db`
  (PostgreSQL), `api` (this backend), and `caddy` (reverse proxy/TLS).

AI assistants: start at [`CLAUDE.md`](CLAUDE.md).

## Changes and release notes

- **[`CHANGELOG.md`](CHANGELOG.md)** — every merged change, internal refactors and tooling
  work included. Established by `[WP16]`; see that file's own header for the convention
  going forward (one dated, Work-Package-tagged entry per merged change).
- **Release Notes** — reserved for changes a guest, electrician, supervisor, admin, or
  superadmin would actually notice, described in their own language rather than
  implementation terms (see `docs/ENGINEERING_CHARTER.md` §18). No customer-visible
  release has been cut yet, so there is no Release Notes file at this time — the first one
  should be created alongside the first tagged release.

## Getting started

See [`apps/api/README.md`](apps/api/README.md) for installing dependencies, running the
test suite, and linting. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for how a change
reaches staging/production.
