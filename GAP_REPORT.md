# AlertProof — Gap Audit Report

> Audit of the implemented codebase against `PLAN.md`, `IMPLEMENTATION_PLAN.md`,
> `PLAN_REVIEW.md`, and `docs/` intent. Audited 2026-07-20. Audit-only; no code changed.
>
> **Counts: 2 BLOCKER · 6 MAJOR · 7 MINOR.**
>
> Overall verdict: the build is far more complete than typical "phase-built" projects — the
> queue/SKIP LOCKED worker, durable Alert dedupe, per-topic reconciliation algorithm,
> LOW_STOCK epochs, escalation unique constraint, GDPR substance, and retention-preserves-
> dedupe rules from PLAN_REVIEW all genuinely made it into code with real tests. The gaps
> that remain are concentrated where the **mock adapters diverge from real-provider shapes**
> — exactly the seam the mock-first strategy couldn't see — plus one entire missing
> production mechanism (billing plan sync).

---

## (A) IMPLEMENTATION GAPS

### BLOCKER 1 — Order-ID format mismatch (REST numeric vs GraphQL GID) breaks reconciliation, dedupe, and write-back against the real Shopify adapter

**Files:**
- `app/lib/ingest/topics.ts:24-40` (`extractOrderId` → `String(payload.id)` = REST numeric id, e.g. `"4001"`)
- `app/lib/adapters/shopify-admin/real.server.ts:71-108` (GraphQL `orders` query returns GIDs, e.g. `"gid://shopify/Order/4001"`, refunds likewise `gid://shopify/Refund/...`)
- `app/lib/ingest/topics.ts:73-105` (`expectedEventsForOrder` builds join keys and synthetic ids from `order.id` as returned by the adapter)
- `app/lib/reconcile/reconcile.server.ts:78-101` (existence check `WebhookEvent(shopDomain, topic, orderId, resourceId)`)
- `app/lib/writeback/order.server.ts:125-141` + `real.server.ts:117-184` (`writeOrderMetafield` passes `Alert.orderId` as `ownerId`; `addOrderNote` queries `order(id: $id)`)

**What's wrong.** Webhook-ingested events store numeric REST ids; the real Admin adapter
returns GIDs. Nothing normalizes between them. In production (real `ShopifyAdmin`):

1. The reconciliation existence check **never matches** any webhook-sourced event → every
   order in every 15-minute scan window is treated as "missed" and synthesized.
2. The synthesized events produce Alerts whose `dedupeKey` embeds the **GID** while the
   original webhook Alerts embed the **numeric id** — the durable `(shopId, dedupeKey)`
   unique does **not** collide → a **duplicate alert for every already-alerted order**.
   This is precisely the PLAN_REVIEW B2 "brand-killing false-alert storm", reintroduced
   through adapter asymmetry.
3. `ReconciliationRun.missedFound` — the "honest-marketing number" — becomes garbage.
4. Write-back: `metafieldsSet` / `orderUpdate` require GIDs, but webhook-sourced
   `Alert.orderId` is numeric → **every write-back for normally-received webhooks fails**
   with userErrors and permanently gives up after `MAX_WRITEBACK_ATTEMPTS = 3`. The
   "status visible right on the order" moat feature is dead in production.

**Why tests are green.** `MockShopifyAdmin` fixtures use the same id style as the webhook
fixtures within each test (`tests/integration/reconciliation.test.ts:36` uses `id: "4001"`
against `payload: { id: 4001 }`; `tests/unit/ingest.test.ts:27` uses GIDs on both sides).
The mismatch only exists across the real-adapter boundary, which no test exercises.
(Notably, `gdpr.server.ts:34-41` `orderWhere` handles *both* formats — the author was aware
of the dual format there but nowhere else.)

**Fix.** Pick one canonical id form (numeric is easiest: webhooks already provide it, admin
links need it). In `RealShopifyAdmin`, request `legacyResourceId` for orders and parse the
trailing numeric segment for refund GIDs; normalize in one place (a `canonicalOrderId()`
helper used by `extractOrderId`, `expectedEventsForOrder`, and write-back, converting to a
GID at the mutation boundary). Add an integration test that pairs REST-shaped webhook
payloads with GID-shaped admin fixtures — the test that would have caught this.

---

### BLOCKER 2 — Production billing has no plan-sync mechanism: paying merchants stay on FREE

**Files:**
- `app/lib/adapters/billing/shopify.server.ts:30-37` (`confirmSubscription` just returns the current stored plan — correct by design per `docs/DECISIONS.md`, but…)
- `app/lib/adapters/outbox.server.ts:51-60` (`PrismaShopPlanStore.set` — the **only** writer of `Shop.plan` — is called exclusively by `MockBillingService`)
- `shopify.app.toml:13-15` (no `app_subscriptions/update` webhook subscription)

**What's wrong.** The managed-App-Pricing design says "read the app's server-side
`Shop.plan` projection" — but **nothing ever writes that projection** outside the mock.
There is no `app_subscriptions/update` webhook handler, no
`currentAppInstallation.activeSubscriptions` query, no sync on the billing page's return
path. After the 14-day trial, a merchant who paid for Standard/Pro through Shopify's
pricing page is entitlement-gated as FREE forever (1 rule, email only, 50 orders/mo, alerts
SKIPPED with `reason: plan`). Cancellations/downgrades likewise never propagate.
`docs/GOING_LIVE.md` §6 tells the operator to "confirm … cancellation synchronization" —
a mechanism that does not exist.

**Fix.** (a) Subscribe to `app_subscriptions/update` in `shopify.app.toml` and add a topic
handler that maps subscription name/status → `Plan` via `ShopPlanStore.set`. (b) As a
belt-and-braces path, query `currentAppInstallation.activeSubscriptions` through the
`ShopifyAdmin` port in the `app.billing` loader (and/or a daily cron) and reconcile
`Shop.plan`. Both fit behind the existing ports without disturbing the mock flow.

---

### MAJOR 1 — A PRO purchase during the trial is entitlement-capped at STANDARD

**File:** `app/lib/billing/plans.server.ts:51-56`

```ts
return shop.trialEndsAt && shop.trialEndsAt > now ? Plan.STANDARD : shop.plan;
```

`effectivePlanForShop` ignores `shop.plan` whenever a trial is active. `provisionShop`
always sets `trialEndsAt = installedAt + 14d`, so every merchant who upgrades to Pro in
their first two weeks (the highest-intent moment) pays $19 while SMS, escalation, and
digests stay gated (`escalate.server.ts:109`, `digest.server.ts:153`, channel gating in
`handlers.server.ts:132`). Tests only cover `plan: FREE` + trial
(`tests/unit/phase6-billing.test.ts:58-72`), so the downgrade path is untested.
**Fix:** return the *max* entitlement: `plan === FREE && trial active → STANDARD`, else
`plan`. One line plus a test case for `{plan: PRO, trialEndsAt: future}`.

---

### MAJOR 2 — Mock delivery lifecycle collapses to instant DELIVERED, breaking the planned bounce/escalation demo and weakening the "sacred" e2e test

**Files:**
- `app/lib/delivery/dispatch.server.ts:80-87` (`terminal = adapter.kind === "mock" || slack || discord` → mock email/SMS jump straight to DELIVERED)
- `app/lib/delivery/log.server.ts:67-86` (`CALLBACK_ALLOWED_FROM.delivered = {delivered}` — correct precedence, but it makes DELIVERED unreachable-from)
- `app/routes/dev.mock.tsx:25-48` ("simulate bounce" action)
- `tests/e2e-pipeline.test.ts:100-117`

**What's wrong.** The plan (Phase 3) specified the mock email provider leaves the delivery
in SENT and emits a synthetic Delivered callback ~1s later, so `dev.mock`'s "simulate
bounce/delivered" buttons demo the full lifecycle. As implemented, mock sends are marked
DELIVERED at dispatch, so "simulate bounce" is a silent no-op (blocked by status
precedence). Consequences: Phase 3's acceptance ("click 'simulate bounce', see the Delivery
row go BOUNCED"), Phase 7's acceptance (bounce → escalate cron → Slack escalation), and
Phase 8's acceptance ("end-to-end demo … simulated bounce → escalation … following README
steps alone") **cannot be performed** in mock mode. Escalation and bounce handling are only
ever tested by hand-editing rows into SENT/BOUNCED (`tests/integration/delivery.test.ts:172`,
`phase7-pro.test.ts`), and `e2e-pipeline.test.ts` "simulates a Postmark callback" against a
row that is *already* DELIVERED — it asserts nothing the dispatch didn't already do. The
brand-promise test never exercises a status change caused by a provider callback, and never
exercises bounce at all.

**Fix.** Make mock email/SMS non-terminal (SENT) at dispatch; in dev, have the worker or the
mock emit the delayed synthetic delivered callback via the existing status route (the plan's
design); extend `e2e-pipeline.test.ts` with a bounce branch (send → SENT → bounce callback →
BOUNCED → escalation created).

---

### MAJOR 3 — Escalation scan can starve and silently stop escalating

**File:** `app/lib/escalation/escalate.server.ts:73-94`

The candidate query selects **all** non-escalated BOUNCED/SENT/DEFERRED deliveries
(`take: 100`, ordered `statusAt asc`) and only *afterwards* filters for a rule escalation
config in JS (`:100-101 continue`). Deliveries of rules **without** escalation configured —
every BOUNCED row on any plan, every email SENT that never receives a provider callback —
are permanent candidates that are re-fetched forever and, once more than 100 accumulate
(they sort oldest-first), **due escalations behind them are never scanned again**. Because
the query is cross-tenant, one shop's stale backlog starves every other shop's Pro
escalations. For the product whose Pro promise is "we escalate when delivery fails," this
is a silent total failure mode.
**Fix:** push the filter into SQL (`rule.escalation` JSON not null — or add a denormalized
`Rule.escalationEnabled` boolean column), and/or exclude candidates older than the maximum
plausible escalation window; add a test with 100+ non-escalating stale rows ahead of one due
row.

---

### MAJOR 4 — Reconciliation's "paid-like" set omits refunded states: a dropped `orders/paid` on a later-refunded order is never recovered

**File:** `app/lib/ingest/topics.ts:66` — `PAID_STATUSES = {"paid", "partially_paid"}`.

Shopify financial status moves to `partially_refunded` / `refunded` after refunds. For such
an order, `expectedEventsForOrder` no longer derives an `orders/paid` expectation, so a
dropped paid webhook is permanently unrecovered — a direct exception to the B3 fix ("a
dropped webhook is indistinguishable from a delivered one after ≤15 min"). The real adapter
feeds `displayFinancialStatus` (GraphQL enum, e.g. `PARTIALLY_REFUNDED`), making this a
live path. **Fix:** add `partially_refunded` and `refunded` to `PAID_STATUSES` (payment
demonstrably happened); test with a refunded fixture.

---

### MAJOR 5 — Postmark callback route 401s on unsupported event types instead of tolerating them

**Files:** `app/lib/adapters/email/postmark.server.ts:72-86` (throws on any RecordType
other than Delivery/Deferred/Bounce), `app/routes/webhooks.email-status.tsx:22-33` (catch →
**401**).

The plan says "Unknown … → store, log, 200 (never 5xx a provider callback)". If the
operator enables Open/Click/SpamComplaint on the Postmark webhook (SpamComplaint is on by
default in Postmark's UI), every such event gets a 401, Postmark retries repeatedly, and
the log fills with retry noise. `SpamComplaint` is also a meaningful hard-failure signal
that's currently dropped. **Fix:** map SpamComplaint → `bounced` (or a recorded terminal),
and have the route 200-ack (after auth verification) any authenticated-but-unsupported
RecordType, storing a ProviderEvent for audit.

---

### MAJOR 6 — Dashboard "Requeue events" is cross-tenant

**File:** `app/routes/app._index.tsx:51-58` → `requeueDeadEvents()`
(`app/lib/ingest/processor.server.ts:230-244` has no shop filter).

Any authenticated merchant clicking the DEAD-events banner requeues **every shop's** DEAD
events (resetting attempts to 0 globally). The dashboard *counts* are correctly scoped to
`session.shop`; the action is not. Mostly harmless replays (dedupe holds), but it is a
tenant-isolation violation and can revive another shop's poison event storm. **Fix:** add a
`shopDomain` argument to `requeueDeadEvents` and pass `session.shop`; keep the global
variant only on the CRON-secret route.

---

### MINOR 1 — Empty webhook-id fallback silently drops events
`app/lib/ingest/webhook-action.server.ts:42-43`: `webhookId || header || ""` — if the id is
ever absent, the first event inserts with `shopifyWebhookId = ""` and **every subsequent
id-less webhook is treated as a duplicate and dropped** (`skipDuplicates`). Fall back to a
random UUID instead of `""`.

### MINOR 2 — Reinstall leaves all rules disabled with no surface
`app/uninstalled` disables every rule (`processor.server.ts:48-63`); `provisionShop`
(`provision.server.ts:28-38`) clears `uninstalledAt` on reinstall but never re-enables rules
or tells the merchant. A reinstalling merchant has a silently inert app — the exact failure
mode the product exists to prevent. Re-enable on reinstall or show a prominent "rules
disabled" banner.

### MINOR 3 — Delivery log UX gaps vs plan
`app/routes/app.log._index.tsx:153-157`: the "Next page" link carries only `before`,
dropping active order/status/channel/date filters. Line 134: the "Open order in Shopify"
link interpolates `orderId` raw — broken for GID-format ids (reconciliation-sourced alerts).
Pruned "skeleton" alerts render with empty delivery lists and no "details expired" label the
plan promised.

### MINOR 4 — Write-back settings have no UI
`app/lib/writeback/order.server.ts:49-63` honors `settings.writeback`,
`writebackMetafield`, `writebackNote`, but no route ever writes those keys
(`app.settings.tsx` covers only timezone + BYO Twilio). The plan (and PLAN_REVIEW risk 3
about the order-note field) intended these to be merchant-controllable. Add three toggles to
Settings.

### MINOR 5 — Undocumented deviations from plan/PLAN_REVIEW
(a) `MAX_DELIVERY_ATTEMPTS = 3` (`log.server.ts:19`) vs plan's "FAILED after 5".
(b) PLAN_REVIEW MINOR 6 asked that the "delivery-status visible on all tiers" pricing
deviation be recorded in `docs/DECISIONS.md` — it isn't.
(c) PLAN_REVIEW MINOR 1 (retry jitter) not applied — pure exponential backoff in
`processor.server.ts:44-46` and `dispatch.server.ts:103` invites synchronized retry
stampedes after an outage. All three are cheap to fix or document.

### MINOR 6 — Retention nulls payloads of still-requeueable DEAD events
`prune.server.ts:154-173` nulls `WebhookEvent.payload` at 30 days regardless of status,
while DEAD events remain requeue-able until deleted at 90 days. A DEAD event requeued
between day 30 and 90 crashes with "no processable payload" and returns to DEAD, confusing
the operator. Exclude DEAD (or PENDING/FAILED) rows from payload nulling, or block requeue
of payload-less events with a clear message.

### MINOR 7 — `dev.mock` is a JSON endpoint, not the promised screen
The plan and README describe a dev "screen" listing MockOutbox with per-message
simulate-bounce/delivered buttons — the demo tool. `app/routes/dev.mock.tsx` is a
bearer-token JSON loader/action with no UI (and its usefulness is currently gutted by
MAJOR 2). Fine for tests; not the planned demo artifact.

---

## (B) RECOMMENDED NEXT STEPS

Ordered by value-for-effort. (The two BLOCKERs above are prerequisites to launch and are
assumed; these are the highest-value items *beyond* straight gap fixes.)

### 1. Production-shape adapter contract tests (Effort: M — highest value)
The whole failure pattern of this build is "mock and real adapter disagree about data
shape" (BLOCKER 1, MAJOR 4; historically the class PLAN_REVIEW B1–B3 lived in). Add a
contract-test layer: a fixture set that mirrors **real** provider shapes — REST webhook
payloads with numeric ids alongside `MockShopifyAdmin` seeded with GID ids and GraphQL
`displayFinancialStatus` enums, Postmark payloads including SpamComplaint, Twilio
form-encoded callbacks — and run reconciliation/write-back/status pipelines across the
boundary. This turns the ID-normalization fix into a regression-proof invariant and is the
single best insurance for the "never drop an alert" brand.

### 2. Restore the full mock delivery lifecycle and build the demo loop (Effort: M)
Fix MAJOR 2 (mock → SENT + delayed synthetic delivered callback), give `dev.mock` its
planned minimal UI (outbox list + simulate buttons), and extend `e2e-pipeline.test.ts` with
the bounce → escalation branch. This simultaneously repairs three phases' acceptance
criteria, makes escalation demonstrable to reviewers/merchants ("flaky-email victims want
proof on day one" — PLAN §4), and hardens the sacred CI test.

### 3. In-app review-ask moment (Effort: S)
PLAN §7's engineered review ask ("We've delivered 214 alerts for you — mind leaving a
review?") was never implemented and nothing in the phases covers it. The dashboard loader
already computes 7-day sent/delivered counts; add a lifetime delivered counter and a
dismissible banner that triggers after N delivered alerts or the first
reconciliation-caught miss (the strongest possible moment). Reviews are the app-store
ranking currency; this is the cheapest high-leverage growth feature in the plan.

### 4. Ops hardening pass on the failure-visibility surfaces (Effort: S)
Scope `requeueDeadEvents` per shop (MAJOR 6); add `oldest stuck SENDING age` and
`writeback failure count` to `/healthz` (`health.server.ts` currently reports only queue
depth/DEAD — write-back failures after 3 attempts are invisible today); add ±20% jitter to
the three backoff sites; surface `writebackError` on the delivery-log order page. Small
diffs, big difference the first time production misbehaves.

### 5. Recipient webhook-URL validation + per-recipient test send (Effort: M)
Slack/Discord URLs are encrypted and stored blind (`app.recipients.tsx`); a typo surfaces
only as a failed delivery during a real order — the worst possible moment. Validate URL
shape on save (`hooks.slack.com/…`, `discord.com/api/webhooks/…`) and add a "send test
message" button per recipient reusing the existing dispatch path with a TEST-source alert.
Complements the global "Test my alerts" button and closes the last unverified merchant
configuration input.
