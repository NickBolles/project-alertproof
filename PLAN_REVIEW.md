# PLAN_REVIEW — Adversarial review of IMPLEMENTATION_PLAN.md

> **Verdict: CONDITIONAL APPROVE.** The architecture (ports/adapters, Postgres-as-queue with
> `SKIP LOCKED`, mock-first phasing) is sound and the phase sequencing mostly holds — but the
> reconciliation design (the product's headline claim) had three blocking correctness holes,
> and the dedupe/retention interaction could produce the exact class of bug the app exists to
> prevent (silently suppressed alerts, and falsely re-fired alerts). All BLOCKER and MAJOR
> fixes below have been folded into IMPLEMENTATION_PLAN.md; with them applied, the plan is
> implementation-ready.
>
> Reviewed 2026-07-20. Counts: **3 BLOCKER · 10 MAJOR · 11 MINOR**.

---

## BLOCKERS

### B1 — Reconciliation cannot find missed events: `WebhookEvent` has no `orderId`
**Problem.** Phase 4 says reconciliation "for each order id, check an Alert-or-WebhookEvent
exists." The `WebhookEvent` table has no order-id column — the order id lives inside the
`payload Json` (unindexed, and Phase 8 nulls payloads after 30 days). The existence check is
either an unindexed JSON scan or impossible. The core loop of the moat feature was
unimplementable as specced.
**Fix (applied).** Add `orderId String?` to `WebhookEvent`, extracted at enqueue time for all
order-scoped topics, with `@@index([shopDomain, topic, orderId])`. Payload pruning keeps the
row *and* the `orderId`, so idempotency/existence history survives retention.

### B2 — Reconciliation re-alerts old / pre-install orders (false-alert storm)
**Problem.** Three compounding flaws: (1) the scan is on `updated_at`, and Shopify bumps
`updated_at` on *any* order change (tags, fulfillment, notes) — so a year-old order edited
today enters the scan window; (2) the synthetic webhook id includes an
`orderUpdatedAtBucket`, so each new update mints a *new* unique id and the
`shopifyWebhookId` unique does not stop re-synthesis; (3) the only remaining guard — the
`Alert (shopId, ruleId, dedupeKey)` unique — is destroyed by Phase 8 retention (FREE prunes
Alerts at 7 days). Net: a merchant on the free tier who edits an old order gets a fresh
"New order!" alert for it. That is a brand-killing false positive.
**Fix (applied).** (a) Synthetic ids drop the time bucket: `recon:{shop}:{topic}:{orderId}`
(and `:{refundId}` for refunds) — at most one synthetic event per topic per resource, ever;
the decision to synthesize comes from the per-topic existence check, and the unique makes
double synthesis impossible. (b) Hard guard: never synthesize for any order with
`created_at < shop.installedAt`. (c) Retention keeps Alert skeleton rows forever (see M8),
so the dedupe unique is durable.

### B3 — Dropped `orders/paid` / `refunds/create` webhooks are never recovered
**Problem.** The existence check is "an Alert-or-WebhookEvent exists" — singular. If
`orders/create` arrived but `orders/paid` was dropped, the check passes and the paid event is
never reconciled. Same for refunds. The plan hand-waved "create/paid/refunds via order
financial status" without an algorithm. The headline claim ("a dropped webhook is
indistinguishable from a delivered one after ≤15 min") was false for two of the four topics.
**Fix (applied).** Reconciliation derives an *expected-event set* per order from order state
(`orders/create` always; `orders/paid` iff `financial_status` indicates paid;
`refunds/create` per refund id in `order.refunds`) and checks/synthesizes **per topic** (per
refund for refunds) against `WebhookEvent(shopDomain, topic, orderId)`.

---

## MAJORS

### M1 — Dead-letter after ~8.5 minutes of failures; DEAD events invisible
**Problem.** Backoff `min(2^attempts, 3600)s` with DEAD at 8 attempts sums to ≈510s — a
10-minute transient outage (DB blip, provider 5xx) permanently dead-letters events with no
operator surface and no replay path. For a "we don't drop things" brand this is the wrong
trade in both directions: too fast to give up, no way to notice or recover.
**Fix (applied).** Backoff `min(30 · 2^attempts, 3600)s`, DEAD after 15 attempts (≈12h of
retrying). DEAD count surfaces on the dashboard and `/healthz`; a dev/admin action re-queues
DEAD events (reset to PENDING, attempts=0). DEAD is an operational alarm, not a silent grave.

### M2 — `Delivery` rows stuck in `SENDING` are never recovered
**Problem.** Dispatch flips PENDING→SENDING via conditional UPDATE, then calls the provider.
A crash between those two steps strands the row in SENDING forever — there is a
stuck-PROCESSING reclaim for `WebhookEvent` but no analog for `Delivery`. Stranded rows also
silently exit the escalation scan's view.
**Fix (applied).** Dispatcher/cron sweeps `SENDING` rows older than 10 min: `attempts++`,
back to PENDING (retry) or FAILED at max attempts. Documented as at-least-once (a crash after
the provider call but before recording SENT may re-send — acceptable and on-brand vs. dropping).

### M3 — Escalation dedupe is "unique-ish" — race → double escalation
**Problem.** Phase 7 guards against duplicate escalations with an "`escalatedFromId`
unique-ish check." Two overlapping cron runs both pass the read-check and create two
escalation deliveries. "Unique-ish" is not a constraint.
**Fix (applied).** `Delivery.escalatedFromId String? @unique` (Postgres allows multiple
NULLs). Concurrent escalators hit the unique; catch and treat as already-escalated.

### M4 — LOW_STOCK dedupe suppresses every re-crossing forever
**Problem.** dedupeKey "includes the crossed threshold so it fires once per crossing" — but
the key (`inventory_item:location[:threshold]`) is identical on the *next* legitimate
crossing (stock recovers to 40, drops below 5 again → suppressed by the durable unique). The
alert fires exactly once per item per lifetime.
**Fix (applied).** New `InventoryState (shopId, inventoryItemId, locationId, lastAvailable,
epoch)` table. On each inventory event compare previous vs. new `available`: crossing down
through the threshold fires; recovering above it increments `epoch`. dedupeKey =
`low_stock:{item}:{location}:{threshold}:{epoch}` — one alert per actual crossing, re-arms on
recovery.

### M5 — Digest "synthetic Alert" violates the schema's non-null FKs
**Problem.** Phase 7 attaches the digest email to "a synthetic digest Alert" — but
`Alert.ruleId` and `Alert.webhookEventId` are required fields with unique constraints
referencing real rows. As written the digest cannot be persisted without inventing fake rules
and fake webhook events.
**Fix (applied).** `Alert.ruleId` and `Alert.webhookEventId` made nullable; new
`Alert.kind AlertKind @default(RULE)` (`RULE | DIGEST`). The `(webhookEventId, ruleId)` unique
still holds for RULE alerts (Postgres treats NULLs as distinct, so DIGEST rows don't
collide); digest idempotency rides the `(shopId, ruleId→NULL, dedupeKey)`… — no: digest
idempotency uses the durable `(shopId, dedupeKey)`-style key `digest:{recipientId}:{date}`
via a partial-unique/explicit-check documented in Phase 7.

### M6 — Nobody owns shop provisioning (afterAuth / install flow)
**Problem.** No phase creates the `Shop` row, sets `trialEndsAt`, fetches the shop timezone,
initializes the reconciliation cursor, or registers webhooks on install. Phase 6 says "trial
set in Phase 1's shop-creation path" — a path that doesn't exist in Phase 1. Webhook handlers
and reconciliation both assume a Shop row exists.
**Fix (applied).** Phase 1 now owns provisioning: the template `afterAuth` hook upserts Shop
(`installedAt`, `trialEndsAt = installedAt + 14d`, timezone via `ShopifyAdmin` port,
`reconcileCursor = installedAt`) and webhook registration is toml-driven; plus a defensive
lazy upsert when a webhook arrives for an unknown shop (mock/bypass path uses the seed).

### M7 — Auth-bypass / dev.mock guard is a denylist, not an allowlist
**Problem.** `ALERTPROOF_AUTH_BYPASS=1` "refuses when NODE_ENV=production" — a misconfigured
production deploy with `NODE_ENV` unset (or `staging`) leaves an unauthenticated admin UI and
a mock-event-injection route exposed. Deny-on-production is the wrong polarity for a
security gate.
**Fix (applied).** Bypass and `dev.mock` activate **only** when *all* hold:
`NODE_ENV === 'development'` (or vitest), `ALERTPROOF_AUTH_BYPASS=1` explicitly set, and
Shopify credentials are the placeholder values (real `SHOPIFY_API_SECRET` ⇒ bypass refuses to
arm). Startup logs a loud banner when armed; Phase 8 keeps the build-time exclusion check.

### M8 — Retention pruning destroys the dedupe guarantees it sits on
**Problem.** Phase 8 deletes `Alert` rows past the plan window (7d on FREE). Every dedupe
mechanism downstream of `WebhookEvent` — reconciliation no-ops, low-stock crossings, digest
idempotency — rests on Alert uniques. Pruning them re-arms alerts for anything Shopify or the
reconciler touches again (see B2).
**Fix (applied).** Retention never deletes Alert rows. It deletes `Delivery` rows and
`ProviderEvent`s past the window and nulls `WebhookEvent.payload`; Alert rows are kept as
skeletons (id, ruleId, dedupeKey, orderId, firedAt — a few dozen bytes) indefinitely. The log
UI shows "details expired" for skeleton alerts. "Unlimited retention" (PRO) is unaffected.

### M9 — Stuck-PROCESSING reclaim can loop forever and can double-run long handlers
**Problem.** The 5-minute PROCESSING reclaim doesn't increment `attempts`, so an event whose
handler reliably crashes the worker is reclaimed and re-crashed indefinitely without ever
reaching DEAD. Separately, a *legitimately* slow handler (paginated Admin-API collection
lookups under rate limiting) can exceed 5 minutes and be claimed twice concurrently.
**Fix (applied).** Reclaim counts as an attempt (`attempts++`, backoff applies, DEAD
eventually reachable). Handlers must stay well under the reclaim window: the collection-
membership lookup is bounded (cache + single page fetch) and any handler nearing the window
should checkpoint by re-enqueueing. Reclaim window set to 10 min to add margin; concurrent
duplicate processing remains safe (at-least-once + Alert uniques) and is documented as such.

### M10 — Refund / payment-failed dedupe keyed on orderId suppresses real events
**Problem.** `dedupeKey = topic:orderId` means the **second partial refund on the same
order never alerts** — the durable Alert unique swallows it. Same for a second failed payment
attempt. This is precisely the "silently missing alert" failure mode the product promises to
eliminate.
**Fix (applied).** dedupeKey is per-resource, not per-order: `refunds/create:{refundId}`,
`order_transactions/create:{transactionId}`; order-lifecycle topics keep `topic:{orderId}`.
Extractors own dedupeKey construction per topic; reconciliation synthesizes per refund id.

---

## MINORS (noted, not folded in — none blocks implementation)

1. **No jitter on retry backoff.** Pure exponential means synchronized retry stampedes after
   an outage. Add ±20% jitter when convenient.
2. **DeliveryStatus precedence is implicit.** "Out-of-order events don't regress DELIVERED"
   is tested but the ranking should be written down once:
   `PENDING < SENDING < SENT < DEFERRED < DELIVERED`, `BOUNCED`/`FAILED` terminal-unless-
   escalated, `SKIPPED` terminal. Put it in `status.server.ts` as a table.
3. **`mock://` URL scheme is an abstraction leak** (chat mock selected by URL, not by the env
   factory — unlike every other port). Acceptable pragmatism; document in `ports/index.ts`
   that payload shaping happens *above* the port so mocks capture real Slack/Discord bodies.
4. **Mock Postmark callback auth is unspecified** ("accepts only mock-signed events" — signed
   how?). Suggest: dev route posts with `Authorization: Bearer ${CRON_SECRET}`; real secret
   present ⇒ that path disabled.
5. **UsageCounter double-counts orders** if incremented on every order-scoped event
   (`orders/create` + `orders/paid` for the same order = 2). Increment on `orders/create`
   (incl. reconciliation-synthesized creates) only.
6. **Pricing mismatch with PLAN.md:** PLAN gates "delivery-status visibility" to Standard;
   the implementation shows provider statuses on all tiers. Recommend keeping it visible on
   FREE (status *is* the product; hiding it undercuts the trial) — but record the deliberate
   deviation in `docs/DECISIONS.md`.
7. **Missing plain indexes:** `Rule@@index([shopId])`, `Recipient@@index([shopId])`,
   `Delivery@@index([recipientId])` (digest compilation query). Cheap; add in Phase 0.
8. **API version pinning not explicit.** Pin the Admin API version in one place
   (`shopify.app.toml` / app config) and record it in `DECISIONS.md`; don't float on the
   template default silently.
9. **GDPR topics config location:** in current `shopify.app.toml` the mandatory topics go
   under `[webhooks] ... compliance_topics` (privacy-compliance subscription), not ordinary
   topic subscriptions, and the endpoint must 401 on bad HMAC. Template handles most of this;
   verify in Phase 1.
10. **`read_orders` only grants ~60 days of order history** — fine for reconciliation (window
    is minutes) but means backfill features would need `read_all_orders` (restricted). Note in
    GOING_LIVE.md.
11. **`MockOutbox` ships in the production schema/migration.** Harmless (unused table), but
    either accept it consciously or exclude via a dev-only migration; don't let an agent
    "clean it up" and break tests.

---

## Cross-cutting observations (no action required)

- **Phase order holds** after fixes: no phase needs live credentials; the two genuinely
  cred-blocked items (real embedded OAuth, live billing charge) are correctly deferred to
  GOING_LIVE.md. Phase 2's dependency on Phase 6 gating is correctly stubbed permissive.
- **`SKIP LOCKED` worker design is sound** for this scale; the claim-then-commit-then-process
  pattern plus reclaim (with M9 applied) gives correct at-least-once semantics, and every
  downstream write is guarded by a unique. Exactly-once is (correctly) not promised —
  duplicate *sends* are possible on crash, duplicate *alerts* are not.
- **The e2e-pipeline test** (signed webhook → queue → rules → dispatch → mock outbox →
  simulated provider callbacks → terminal Delivery) is the right single artifact to prove the
  brand promise in CI with zero credentials. Keep it sacred.
