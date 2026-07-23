# Notifications & Real-Time Delivery

How an in-app notification travels from a business event to a user's screen. This subsystem
spans a persisted model, an audience-dispatch layer, a unified trigger interface, a
real-time transport, and a poll fallback. This document is the *map* of that flow; it links
to the canonical owners of the rule, the data model, and the scaling constraint rather than
restating them.

## The flow, end to end

```
business event (ticket assigned, complaint filed, alert fires)
   │
   ▼
notify({ orgId, to, type, title, body, entityId, isUrgent, email? })   ← services/notification-service.js
   │                                                        └─ optional paired email → lib/email.js
   ▼
audience dispatch (NOTIFY_CHANNELS): userId · workerId · admins · supervisors · supervisorIds · workerIds
   │
   ├─► persist a Notification row (createNotification / batched createMany)      [durable]
   │
   └─► pushNotification() → SSE  (services/sse.js)                               [real-time]
   ▼
recipient's browser:  live via EventSource   OR   polled on next load
```

## 1. The unified trigger: `notify()`

`services/notification-service.js` exposes **`notify()`** as the single entry point for
raising a notification (and, optionally, its paired email in one call). The *rule* that all
notification+email pairings go through this one interface — and the `NOTIFY_CHANNELS`
audience table it dispatches through — is **owned by the Engineering Charter §5**
([`../ENGINEERING_CHARTER.md`](../ENGINEERING_CHARTER.md)); see there for the "why one
interface" reasoning and [`0004`](../adr/0004-resilience-as-shared-primitives.md)'s sibling
pattern of baking behavior into a shared primitive.

Underneath, the audience helpers (`createNotification`, `notifyAdmins`, `notifySupervisors`,
`notifySupervisorIds`, `notifyWorkers`) each **persist** rows (batched via `createMany` for
multi-recipient sends — Charter §7) and then **push** them live.

## 2. Persistence — nothing is lost offline

Every notification is a **`Notification` row** (`orgId`, `userId` *or* `workerId`, `type`,
`title`, `body`, `entityId`, `isRead`, `isUrgent`; see
[`data-model.md`](data-model.md)). Persistence is what makes the poll fallback work: a
recipient who was offline or not SSE-connected still sees the notification on their next
load, because it was stored, not only pushed.

## 3. Real-time delivery — SSE

`services/sse.js` is an **in-memory Server-Sent Events registry**: a
`Map<orgId, Map<"user:id"|"worker:id", Set<reply>>>` of open connections.

- Recipients open a stream: `GET /api/notifications/stream` (authenticated staff) or
  `GET /api/notifications/worker-stream` (workers, token via query param). Each connection
  is registered with `addConnection`, kept alive by a **30-second heartbeat**, and removed
  on close (`routes/notifications.js`, `routes/worker-auth.js`).
- `pushNotification(orgId, notification)` sends an SSE `notification` event to the specific
  user/worker; `pushAlert(orgId, alert)` **broadcasts** an `alert` event to every connected
  member of the org (used by the automation engine — see [`resilience.md`](resilience.md)).
- `getConnectionStats()` exposes live connection counts for health/monitoring.

## 4. Poll fallback

When SSE isn't connected (page just loaded, reconnecting, or a proxy that buffers), the
frontend falls back to polling the persisted rows: `GET /api/notifications/unread-count`
and the paginated `GET /api/notifications`, with `PATCH …/read-all`, `…/:id/read`, and
delete endpoints. The browser side of this lives in `app.js` (the notification bell); see
[`frontend.md`](frontend.md).

## 5. The scaling constraint (important)

The SSE registry is an **in-process `Map`, per instance**. With more than one app instance,
a client connected to instance A will **not** receive a push triggered on instance B — the
notification is still persisted (so the poll fallback catches it), but real-time delivery is
single-instance only. This is a deliberate consequence of the modular-monolith,
single-VM model ([`0002`](../adr/0002-modular-monolith.md)) and is the **canonical concern
of [`../SCALING.md`](../SCALING.md)**, which flags it as the most significant multi-instance
gap and describes what changing it would require. Not restated here — go there before
scaling out.

## Ownership boundaries

| Concern | Canonical owner |
|---|---|
| The "one `notify()` interface" rule + `NOTIFY_CHANNELS` | Charter §5 |
| The `Notification` model / fields | [`data-model.md`](data-model.md) + `schema.prisma` |
| The multi-instance SSE limitation | [`../SCALING.md`](../SCALING.md) |
| Alert generation that feeds `pushAlert` | [`resilience.md`](resilience.md) (automation) |
| The end-to-end mechanism (this doc) | here |

## Related

- [overview.md](overview.md) · [data-model.md](data-model.md) · [resilience.md](resilience.md) ·
  [frontend.md](frontend.md)
- Code: `services/notification-service.js`, `services/sse.js`, `routes/notifications.js`,
  `lib/email.js`
- Rule: [`../ENGINEERING_CHARTER.md`](../ENGINEERING_CHARTER.md) §5
