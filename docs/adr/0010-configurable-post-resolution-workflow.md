# 0010. A post-resolution workflow that reaches the resident, with configurable alternatives

- **Status:** Proposed
- **Date:** 2026-10-24
- **Deciders:** platform owner, engineering (PAR-10 review)

## Context

The 2026-10 product and architecture review
([PAR-10 §6](../history/product-architecture-review-2026-10.md#6-post-resolution-confirmation-verification-and-feedback))
found that the resident's confirmation of a fix mostly confirms that 30 minutes have passed:
- An electrician resolves with a mandatory photo, and the assigned supervisor verifies. That
  part works, and supervisor verification is an intentional rule.
- For public tickets a review link is created that is valid for **30 minutes**. Nobody sends it
  to the resident: the supervisor page copies it to the clipboard, and the admin page cannot
  show it.
- Once the window passes, the next page load closes the ticket and records `CONFIRMED`
  (`tickets.js:59-77`). Silence is recorded as approval.
- The resident cannot see the proof photo on the review page (PAR-10/23).
- Electricians receive the review token through their API and so can "confirm as the
  resident" (PAR-10/14).
- A guest rejection keeps the resolution timestamps, unlike every other reopen (PAR-10/55).
- Internal tickets never reach CLOSED without an admin's manual edit.

Constraints:
- **Residents have no accounts**, and the QR flow must stay account-free.
- **Collect as little personal data as possible.** Some residents may be under 18, and the
  DPDP Rules apply from 2027-05-13 (PAR-10 §15.1).
- **No new service** ([ADR 0002](0002-modular-monolith.md)).
- **Institutions differ.** A hostel room, a classroom corridor and a hospital ward need
  different rules, so the behaviour must be a per-org setting
  ([ADR 0011](0011-tenant-feature-settings.md)), not a fork.

Mainstream service-management practice keeps "resolved" and "closed" apart. The user closes
when satisfied, or the system closes after days, not minutes, and a non-response is recorded
as such (PAR-10 §15.1-1).

## Decision

1. **Supervisor verification stays mandatory** before a public ticket counts as resolved.
2. **The resident is reached on their own device.** The complaint confirmation offers "Track
   this complaint", backed by a per-complaint tracking token kept on that device. The review
   step appears there and only there. Electricians never receive it, and staff see its status,
   not a usable link.
3. **Outcomes are explicit:** `CONFIRMED`, `REJECTED`, `NO_RESPONSE` and
   `CONFIRMED_IN_PERSON`. The last is an audited staff action. Each outcome is stored with its
   time and actor type: resident, staff or system. `NO_RESPONSE` never counts as satisfaction.
4. **The waiting period is an org setting**, with a default of 72 hours. It applies to new
   review links only.
5. **Silence closes as `NO_RESPONSE` by default.** An org can choose "escalate to the supervisor"
   instead. Safety categories never close on silence.
6. **A rejection reopens the ticket to the pool** and clears the resolution fields, as every
   other reopen does. A second rejection of the same ticket also notifies the admin.
7. **A 1–5 rating with a comment** is an optional setting, off by default.
8. **Internal tickets close on verification**, so "closed" means the same for every ticket.
9. **Every transition is conditional on the expected current status** and answers 409
   otherwise.

Each part is a setting with today's value as its default until the pilot (PAR-10 §14) shows
the new defaults work. The settings are: resident step off, optional or required, per
category; the wait period; what silence does; stricter safety verification; and rating on or
off.

## Alternatives considered

- **Supervisor verification only, no resident step.** This is the cheapest option, but it
  drops the only signal from the person who lives with the fault. It stays available as a
  setting ("resident step off").
- **Resident confirmation required before closing.** This gives the strongest evidence, but
  residents leave, change rooms or never answer. Tickets would pile up, and common areas have
  no single resident. It is available per category, not as the default.
- **Keep the 30-minute link and staff hand-over (today).** The recorded outcome means nothing,
  and staff can confirm for the resident.
- **SMS or WhatsApp as the default channel.** SMS needs DLT registration of the sender, header
  and templates. WhatsApp is priced per message, and both need the resident's phone number
  (PAR-10 §15.1-6). They stay possible later as opt-in channels per org.
- **Resident accounts.** These add friction and personal data for a one-off interaction.

## Consequences

- **Easier:** a confirmation means what it says; reports separate silence from satisfaction;
  reopen and dispute counts come from a field, not from best-effort audit rows.
- **Harder:** the "confirmed" share will fall once silence stops counting, so admins must be
  told in advance. Tickets wait in RESOLVED for up to the wait period, so dashboards must show
  "awaiting resident" separately from open work. The tracking link reaches only residents who
  keep it, which the pilot measures.
- **Commits future work to:** additive schema changes (new outcome values and timestamps); a
  tracking endpoint and page; tests for every outcome; the settings of
  [ADR 0011](0011-tenant-feature-settings.md); a short admin briefing.
- **Past data:** rows that timed out before this change stay `CONFIRMED`. Reports mark the
  date the new rule began.
- **Reversal:** turning the resident step off restores supervisor-only closure without a
  deploy.

## Related

- [PAR-10 review](../history/product-architecture-review-2026-10.md): §5 (lifecycle today), §6
  (options and recommendation), §10 B-07, findings PAR-10/14, /23, /30, /55.
- [ADR 0011](0011-tenant-feature-settings.md): where the settings live.
- [`../ENGINEERING_CHARTER.md`](../ENGINEERING_CHARTER.md) §8.1–§8.2 (transactions, dedicated
  transition routes).
