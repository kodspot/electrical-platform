# Personal Data Inventory

Every place the platform holds data about a person, why, and for how long. Check this file
against `apps/api/prisma/schema.prisma` whenever a model changes (Charter §22).

Written from the code on 2026-11-06. Hosting location and provider contracts are not visible
in the repository; they are marked **owner to confirm**.

## People

| Person | Who they are | Sign-in |
|---|---|---|
| Resident (guest) | Reports a problem through a QR sticker | None |
| Electrician (`Worker`) | Does the work | Employee ID + PIN |
| Supervisor, Admin (`User`) | Staff of the organization | Email + password |
| Super admin (`User`) | Kodspot operator | Admin key |

## What is stored

| Data | Model and fields | Purpose | Protection | Kept for |
|---|---|---|---|---|
| Resident name and phone | `Ticket.guestName`, `guestPhone` | Follow up on the complaint | **Plain text.** Asked only with consent, enforced by the server (BUG-0060) | Anonymized after 180 days (`cleanup.js`) |
| Resident name in the audit trail | `AuditLog.actorId`, `newValue` (`ticket_public_create`) | Trace of a public report | Plain text | Anonymized after 180 days |
| Resident network trace | `Ticket.sourceIp` (hash prefix), `userAgent` (first 200 chars) | Abuse detection | IP is hashed, not stored | Life of the ticket. **No retention rule** (AUD-11/07) |
| Complaint text and photo | `Ticket.title`, `description`, `imageUrl` | The complaint | Photo stored privately, read through a signed-in or review-token route | Photo 30 days; text for the life of the ticket |
| Electrician identity | `Worker.name`, `employeeId`, `phone`, `email`, `address`, `dateOfBirth`, `gender`, `department`, `designation`, `dateOfJoin`, `notes` | Employment and assignment | Plain text | Until the admin deletes them |
| Electrician sensitive data | `Worker.aadharNo`, `bloodGroup` | ID proof, emergency | Encrypted (AES-256-GCM, `lib/crypto.js`) | As above. See AUD-11/02 on Aadhaar |
| Electrician credentials | `Worker.pinHash`, `resetToken` | Sign-in | bcrypt; reset token stored as a digest | Until changed |
| Staff identity | `User.name`, `email`, `phone`, `address`, `dateOfBirth`, `employeeId`, and similar | Employment | Plain text, except `aadharNo` and `bloodGroup` | Until deleted |
| Staff credentials | `User.passwordHash`, `resetToken` | Sign-in | bcrypt; digest | Until changed |
| Work records | `Attendance`, `DutyRoster*`, `ElectricalInspection`, ticket resolution fields | Operations | Tenant-scoped | Subscription plus 90 days, per the notice |
| Inspection and proof photos | `ElectricalImage.imageUrl`, `Ticket.resolvedImageUrl`, asset images | Evidence | Private storage | Inspection and ticket photos 30 days. **Asset images have no retention rule** (AUD-11/08) |
| Activity | `AuditLog`, `Notification` | Accountability | Tenant-scoped | Subscription plus 90 days |
| AI use | `AiUsageLog` (user id, tokens) | Quotas | Tenant-scoped | Not limited |
| Browser storage | `localStorage`: session tokens, name, organization; IndexedDB: offline inspections | Sign-in, offline work | On the device; cleared at sign-out | Until sign-out |

## Who else receives it

| Recipient | What | Why | Owner to confirm |
|---|---|---|---|
| Cloudflare R2 | Photos, encrypted database backups | Storage | Contract, region |
| Amazon SES | Staff email address, ticket details in the email | Notifications | Contract, region |
| Google Gemini or Azure OpenAI (only if AI is switched on) | Location names, shift and status counts, ticket titles, and chat text | AI summaries | Contract, region, the "no training" and "no retention" claims in the notice |
| GitHub | No production personal data | Code and CI | Nothing |
| The hosting provider | Everything, at rest on the server | Hosting | Provider, region, disk encryption |

Staff names no longer go to AI providers (BUG-0074). A ticket title written by a resident
could still contain a name, because it is sent as written.

## Ways to exercise rights

| Right | How today |
|---|---|
| Access, portability | "Download my data" in the account menu (`/auth/export`, `/auth/worker-export`) |
| Correction | Profile screen for contact details; otherwise the admin |
| Erasure | The admin deletes the person. Residents write to the Grievance Officer, and an admin uses "Erase this person's details" on the complaint (`POST /tickets/:id/erase-reporter`) |
| Grievance | `privacy@kodspot.in`, named in the privacy notice |
