# AlertProof — Phased Implementation Plan

> **Status — 2026-07-20: ✅ All phases implemented, adversarially reviewed, gap-audited, and hardened.**
> 108 tests pass, the production build passes, and the Docker image builds (`project-alertproof`, 718 MB).
> `main` on GitHub is the source of truth. All BLOCKER/MAJOR gaps in [`GAP_REPORT.md`](./GAP_REPORT.md) are fixed
> (order-ID GID normalization, real billing sync, escalation/refund/tenant fixes, + a production-shape contract suite).
>
> **Status — 2026-08-12: deployed to the Hostinger VPS and healthy, but running in mock/demo mode.**
> Launch is gated on configuration, credentials, and App Store listing collateral — not on code.
> See [`docs/LAUNCH_PLAN.md`](./docs/LAUNCH_PLAN.md) for the audited component status, the six
> blockers, and the day-by-day execution plan.
>
> **Next steps:**
> - **Launch** → [`docs/LAUNCH_PLAN.md`](./docs/LAUNCH_PLAN.md) — blockers, ordered tasks, human gates.
> - **Deploy & live-test** → [`DEPLOYMENT_HANDOFF.md`](./DEPLOYMENT_HANDOFF.md) — VPS + Traefik + Shopify dev-store runbook.
> - **Remaining backlog** → [`GAP_REPORT.md`](./GAP_REPORT.md) §B: in-app review-ask moment; recipient webhook-URL validation + per-recipient test send; ops polish (backoff jitter, write-back failures on `/healthz`).
> - **Standing risk:** correctness is proven against mocks; replicate the production-shape contract-test pattern as real credentials are wired.

> Engineer-ready build plan derived from `PLAN.md`. Each phase is a self-contained unit one
> coding agent can implement in one sitting. **No phase requires live external credentials** —
> every external dependency sits behind an adapter with a mock implementation selected by env
> vars. Real credentials are dropped in later without code changes.
>
> Written 2026-07-20. Items marked **[verify at build time]** must be checked against current
> Shopify docs during Phase 0 — do not block on them here.

---

## 1. Architecture Decisions

### 1.1 Stack

| Concern | Decision | Rationale |
|---|---|---|
| App framework | **Shopify React Router 7 app template** (`shopify app init --template=https://github.com/Shopify/shopify-app-template-react-router`, package `@shopify/shopify-app-react-router`) | This is Shopify's current recommended path. PLAN.md says "Remix template" — Remix v2 merged into React Router v7 and Shopify forked its Remix template into the React Router template; the Remix package is now maintenance-only. Conventions (loaders/actions, `shopify.server.ts`, Prisma session storage) are near-identical. **[verify at build time]** that this is still the recommended template when scaffolding. |
| Language | TypeScript, strict mode | Template default. |
| DB | **Postgres + Prisma** | Template ships SQLite by default — switch to Postgres immediately (Prisma `Json` columns are unsupported on SQLite and we need them for webhook payloads). Local dev via `docker-compose.yml` (postgres:16). Production: Supabase/Fly Postgres, same `DATABASE_URL`. |
| Queue | **Postgres-as-queue** (a `WebhookEvent` table claimed with `SELECT ... FOR UPDATE SKIP LOCKED`) | No Redis/BullMQ. One fewer service, fully transactional with business data, trivially inspectable. Reliability comes from the DB, retries, and the reconciliation cron — not from queue infrastructure. |
| Worker | **In-process worker loop** started alongside the web server (`setInterval` poll, ~2s) + immediate fire-and-forget kick after each webhook ack + HTTP cron endpoints (`/internal/cron/*` guarded by `CRON_SECRET`) so a hosted scheduler (Fly machines cron, Railway cron, GitHub Actions) can also drive it | Single deployable unit fits Fly/Railway at $10–20/mo. The HTTP endpoints mean the worker also works on platforms that sleep processes. |
| UI | Polaris (web components / `@shopify/polaris` per current template default **[verify at build time]**), App Bridge, embedded | Native admin feel; required for app review. |
| Email provider | **Postmark** (primary adapter). `EmailProvider` interface means Resend can be added later. | Postmark's delivery/bounce webhooks are the backbone of the delivery log. |
| Tests | **Vitest**. Unit tests against fakes/in-memory repos (no DB). Integration tests against real Postgres, gated by `TEST_DATABASE_URL` (skipped when unset). One end-to-end "pipeline" test: fake webhook → queue → rules → mock providers → delivery log. | CI must pass with zero external credentials. |
| Lint/CI | ESLint + Prettier (template defaults) + `tsc --noEmit` + `vitest run`, GitHub Actions on push. | Per README kickoff constraints. |

### 1.2 External-service abstraction (the load-bearing decision)

Every external dependency is accessed only through an interface ("port") defined in
`app/lib/ports/`. Concrete adapters live in `app/lib/adapters/`. A single factory
(`app/lib/adapters/index.server.ts`) selects real vs. mock **based on whether the relevant env
var is set** (with an explicit `ALERTPROOF_FORCE_MOCKS=1` override for dev/test):

| Port | Real adapter | Mock adapter (default when env var absent) |
|---|---|---|
| `EmailProvider` (`send`, `verifyStatusWebhook`, `parseStatusEvent`) | Postmark REST API | `MockEmailProvider`: writes an `outbox` row to a `MockOutbox` table + console log; returns a fake `providerMessageId`; a dev-only route can simulate delivered/bounced callbacks. |
| `ChatWebhookProvider` (`postToWebhookUrl`) — covers Slack and Discord (both are "POST JSON to a merchant-supplied webhook URL") | `fetch` with per-service payload shaping | `MockChatProvider`: records payload to `MockOutbox`; URLs beginning `mock://` always used in tests. |
| `SmsProvider` (`send`, `parseStatusCallback`) | Twilio REST API (app-level or merchant BYO creds) | `MockSmsProvider`: records to `MockOutbox`, emits synthetic delivery receipt. |
| `ShopifyAdmin` (`getOrdersUpdatedSince`, `writeOrderMetafield`, `addOrderNote`, `getProduct/Collection membership`) | Admin GraphQL client from the template's `authenticate`/`unauthenticated` helpers | `MockShopifyAdmin`: in-memory order store seeded by fixtures; records metafield/note writes for assertion. |
| `BillingService` (`getPlan`, `requestSubscription`, `confirmSubscription`) | Shopify Billing API via app package | `MockBillingService`: flips `Shop.plan` directly; dev route to switch plans. |
| `Clock` (`now`) | `Date` | Fake clock for escalation/digest/retention tests. |

Rules: **no business code ever imports an adapter directly** — only ports via the factory.
Adapters contain zero business logic (no rule evaluation, no DB writes beyond their own
outbox/audit). This is what lets a later human paste in real API keys and go live untouched.

Shopify OAuth/HMAC is the one dependency we can't fully hide behind a port (the template owns
it). Strategy: run everything with placeholder `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET` values
(`dev-key`/`dev-secret`); webhook HMAC verification works fine locally because our test
harness signs payloads with the same placeholder secret. Real embedded OAuth against a dev
store is the one thing that genuinely needs real Partner credentials — everything else is
testable without them.

### 1.3 Repo layout

```
alertproof/
  prisma/
    schema.prisma
    seed.ts                      # dev seed: 1 shop, 2 recipients, 3 rules, sample orders
  docker-compose.yml             # postgres:16 for local dev
  .env.example                   # every env var, documented, marked MOCKABLE/REQUIRED
  shopify.app.toml               # app config incl. webhook subscriptions [template-managed]
  app/
    shopify.server.ts            # template: app setup, session storage, billing config
    db.server.ts                 # Prisma client singleton
    entry.server.tsx             # + worker bootstrap (start loop unless DISABLE_WORKER=1)
    lib/
      env.server.ts              # zod-validated env parsing; single source of truth
      crypto.server.ts           # AES-256-GCM encrypt/decrypt for stored secrets
      ports/index.ts             # all port interfaces + shared types
      adapters/
        index.server.ts          # factory: env-driven real-vs-mock selection
        email/{postmark,mock}.server.ts
        chat/{slack,discord,mock}.server.ts
        sms/{twilio,mock}.server.ts
        shopify-admin/{real,mock}.server.ts
        billing/{shopify,mock}.server.ts
      ingest/
        enqueue.server.ts        # persist WebhookEvent (idempotent), fast path
        processor.server.ts      # claim + process + retry/backoff + dead-letter
        worker.server.ts         # poll loop
      rules/
        evaluate.server.ts       # pure: (trigger, payload, rules) -> fired rules
        triggers.ts              # trigger enum + payload extractors per topic
      delivery/
        dispatch.server.ts       # Alert -> Delivery rows -> channel adapters
        templates.server.ts      # message rendering per channel
        status.server.ts         # provider status events -> Delivery updates
      writeback/order.server.ts  # metafield + order note updates
      reconcile/reconcile.server.ts
      escalation/escalate.server.ts
      digest/digest.server.ts
      billing/plans.server.ts    # plan definitions, feature gates, usage caps
      retention/prune.server.ts
    routes/
      webhooks.shopify.tsx       # all Shopify topics: verify -> enqueue -> 200
      webhooks.email-status.tsx  # Postmark delivery/bounce callbacks
      webhooks.sms-status.tsx    # Twilio status callbacks
      internal.cron.$job.tsx     # dispatch|reconcile|escalate|digest|prune (CRON_SECRET)
      dev.mock.tsx               # dev-only: view MockOutbox, simulate provider events
      app.tsx                    # embedded shell/nav
      app._index.tsx             # dashboard + onboarding checklist
      app.rules._index.tsx / app.rules.$id.tsx / app.rules.new.tsx
      app.recipients.tsx
      app.log._index.tsx / app.log.$orderId.tsx
      app.settings.tsx
      app.billing.tsx
      app.test-alerts.tsx        # "test my alerts" action
  tests/
    helpers/                     # fixture builders, HMAC signer, fake clock, test db utils
    unit/                        # no DB
    integration/                 # gated by TEST_DATABASE_URL
    e2e-pipeline.test.ts
  docs/GOING_LIVE.md             # produced in final phase: how to add real creds & deploy
  .github/workflows/ci.yml
```

(Exact route-file naming follows the template's convention — flat routes vs. `routes.ts`
config differs between template versions; **[verify at build time]** and keep whichever the
scaffold generates.)

### 1.4 Reliability pipeline (make this concrete everywhere)

```
Shopify webhook ──► verify HMAC ──► INSERT WebhookEvent (unique shopifyWebhookId) ──► 200 OK
                                          │                                   (target <150ms)
                                          ▼ (worker poll ≤2s + immediate kick)
                       claim via FOR UPDATE SKIP LOCKED, status=processing
                                          │
                       evaluate rules ──► create Alert + Delivery rows (transactional)
                                          │
                       dispatch each Delivery via channel adapter (idempotent per row)
                                          │
                       provider status webhooks update Delivery status
                                          │
                       write-back: order metafield + note = alert summary
Every 15 min: reconciliation cron polls Orders API (updated_at >= cursor − overlap), derives
the EXPECTED event set per order from order state (create always; paid iff financial_status
says so; refunds per refund id), checks each against WebhookEvent(shopDomain, topic, orderId),
and inserts synthetic WebhookEvents (source=RECONCILIATION) only for the missing ones — same
pipeline, same idempotency, so a dropped webhook is indistinguishable from a delivered one
after ≤15 min. Orders with created_at < shop.installedAt are never reconciled.
```

Idempotency keys, explicitly:
- `WebhookEvent.shopifyWebhookId` — unique; duplicate deliveries from Shopify are no-ops
  (`INSERT ... ON CONFLICT DO NOTHING`). Reconciliation events use synthetic ids with **no
  time component**: `recon:{shop}:{topic}:{orderId}` (refunds: `recon:{shop}:refunds/create:
  {refundId}`) — at most one synthetic event per topic per resource can ever exist; the
  per-topic existence check decides whether to synthesize, the unique makes double synthesis
  impossible.
- `WebhookEvent.orderId` (nullable, extracted at enqueue for order-scoped topics, indexed) is
  the reconciliation join key — existence checks never parse `payload` (which retention may
  null out; `orderId` survives pruning).
- `Alert` unique on `(webhookEventId, ruleId)` — reprocessing a claimed-but-crashed event
  can't double-fire rules. Additionally unique on `(shopId, dedupeKey)` so a reconciliation
  event for an already-alerted resource is a no-op. `dedupeKey` embeds the rule and is
  **per-resource, per topic** (extractors own it): `{ruleId}:{topic}:{orderId}` for
  order-lifecycle topics, `{ruleId}:refunds/create:{refundId}` (a second partial refund on
  the same order MUST alert), `{ruleId}:order_transactions/create:{transactionId}`,
  `{ruleId}:low_stock:{item}:{location}:{threshold}:{epoch}` for inventory (see Phase 2 —
  `epoch` re-arms the alert after stock recovers), and `digest:{recipientId}:{date}` for
  digests (kind=DIGEST, ruleId null — which is why the unique is on dedupeKey alone, not
  `(shopId, ruleId, dedupeKey)`: PG composite uniques don't constrain NULL columns).
  **These uniques are durable: retention never deletes Alert rows (Phase 8), only their
  heavyweight children.**
- `Delivery` dispatch flips `status pending → sending` with a conditional UPDATE (affected
  rows = 1 required) before calling the provider — a crashed dispatch retries, a concurrent
  one skips. A sweep reclaims `SENDING` rows older than 10 min (`attempts++`, back to PENDING
  or FAILED at max) so a crash between the UPDATE and the provider call cannot strand a
  delivery forever. Semantics are at-least-once: a crash after the provider call but before
  recording SENT may re-send — acceptable; duplicate *sends* are possible, dropped ones are not.

---

## 2. Data Model (Prisma)

`Session` comes from the template (Prisma session storage) — keep as-is. Our models
(key fields only; agents add timestamps `createdAt/updatedAt` and indexes noted):

```prisma
model Shop {
  id            String   @id @default(cuid())
  shopDomain    String   @unique            // e.g. my-store.myshopify.com
  plan          Plan     @default(FREE)     // FREE | STANDARD | PRO
  installedAt   DateTime @default(now())    // reconciliation lower bound; trial anchor
  trialEndsAt   DateTime?
  billingChargeId String?
  timezone      String   @default("UTC")    // IANA, fetched via ShopifyAdmin port at install
  reconcileCursor DateTime?                 // orders updated_at high-water mark; init = installedAt
  settings      Json     @default("{}")     // writeback on/off, note vs metafield, etc.
  uninstalledAt DateTime?
  // relations: rules, recipients, alerts, webhookEvents...
}

enum Plan { FREE STANDARD PRO }

model WebhookEvent {                         // THE queue table
  id               String   @id @default(cuid())
  shopDomain       String
  topic            String                    // e.g. "orders/create"
  shopifyWebhookId String   @unique          // X-Shopify-Webhook-Id or synthetic recon id
  source           EventSource @default(WEBHOOK) // WEBHOOK | RECONCILIATION | TEST
  orderId          String?                   // extracted at enqueue for order-scoped topics;
                                             // reconciliation join key — survives payload pruning
  payload          Json?                     // nullable: retention nulls it after 30d, row stays
  status           EventStatus @default(PENDING) // PENDING|PROCESSING|PROCESSED|FAILED|DEAD
  attempts         Int      @default(0)
  nextAttemptAt    DateTime @default(now())
  lastError        String?
  receivedAt       DateTime @default(now())
  processedAt      DateTime?
  @@index([status, nextAttemptAt])           // worker claim query
  @@index([shopDomain, topic, orderId])      // reconciliation existence check
  @@index([shopDomain, topic, receivedAt])
}

model Rule {
  id          String  @id @default(cuid())
  shopId      String
  name        String
  enabled     Boolean @default(true)
  trigger     Trigger // ORDER_CREATED|ORDER_PAID|ORDER_VALUE_GTE|PRODUCT_ORDERED|
                      // LOW_STOCK|REFUND_CREATED|PAYMENT_FAILED
  conditions  Json    @default("{}")   // {minValue?, productIds?, collectionIds?, stockThreshold?}
  escalation  Json?                    // Pro: {afterMinutes, channel} — null = off
  recipients  RuleRecipient[]
}

model Recipient {
  id                String  @id @default(cuid())
  shopId            String
  name              String
  email             String?
  slackWebhookUrlEnc   String?   // AES-256-GCM encrypted at rest
  discordWebhookUrlEnc String?
  phoneE164         String?     // Pro/SMS
  digestEnabled     Boolean @default(false)
  digestHourLocal   Int     @default(8)
}

model RuleRecipient {
  ruleId      String
  recipientId String
  channels    Channel[]   // EMAIL|SLACK|DISCORD|SMS (Postgres enum array)
  @@id([ruleId, recipientId])
}

model Alert {                                // "rule R fired for order O" (or a digest)
  id             String  @id @default(cuid())
  shopId         String
  kind           AlertKind @default(RULE)     // RULE | DIGEST
  ruleId         String?                      // null for DIGEST alerts
  webhookEventId String?                      // null for DIGEST alerts
  dedupeKey      String                       // per-resource, per-topic — see §1.4
  orderId        String?                      // Shopify order GID/id
  orderName      String?                      // "#1024"
  orderValue     Decimal?
  firedAt        DateTime @default(now())
  deliveries     Delivery[]
  @@unique([webhookEventId, ruleId])          // NULLs distinct in PG — DIGEST rows never collide
  @@unique([shopId, dedupeKey])               // durable dedupe: rows never pruned (Phase 8);
                                              // dedupeKey embeds ruleId for RULE alerts
  @@index([shopId, orderId])
}

enum AlertKind { RULE DIGEST }

model Delivery {                             // one send attempt: alert × recipient × channel
  id                String  @id @default(cuid())
  alertId           String
  recipientId       String
  channel           Channel
  status            DeliveryStatus @default(PENDING)
    // PENDING|SENDING|SENT|DELIVERED|BOUNCED|DEFERRED|FAILED|SKIPPED
  providerMessageId String?   @unique         // join key for provider status webhooks
  providerDetail    Json?                     // raw provider status payloads (append)
  attempts          Int @default(0)
  isEscalation      Boolean @default(false)
  escalatedFromId   String?  @unique          // Delivery that triggered this escalation —
                                              // UNIQUE (PG allows many NULLs): a delivery can
                                              // be escalated at most once; concurrent escalate
                                              // crons hit the constraint, not a double-send
  sentAt            DateTime?
  statusAt          DateTime?
  lastError         String?
  @@index([status, sentAt])                   // escalation scan + stuck-SENDING sweep
  @@index([alertId])
}

model InventoryState {                        // low-stock crossing detection (Phase 2)
  shopId          String
  inventoryItemId String
  locationId      String
  lastAvailable   Int
  epoch           Int @default(0)             // ++ when stock recovers above threshold;
                                              // part of the low_stock dedupeKey so alerts
                                              // re-arm after recovery
  @@id([shopId, inventoryItemId, locationId])
}

model ProviderEvent {                         // raw inbound provider callbacks (audit)
  id                String @id @default(cuid())
  provider          String                    // postmark|twilio|mock
  providerMessageId String?
  type              String                    // Delivery|Bounce|Deferred|sms-status...
  payload           Json
  receivedAt        DateTime @default(now())
  processedAt       DateTime?
  @@index([providerMessageId])
}

model ReconciliationRun {
  id            String   @id @default(cuid())
  shopId        String
  startedAt     DateTime @default(now())
  finishedAt    DateTime?
  cursor        DateTime                     // orders updated_at high-water mark
  ordersChecked Int @default(0)
  missedFound   Int @default(0)              // the honest-marketing number
  error         String?
}

model UsageCounter {                          // free-tier 50 orders/mo cap
  shopId      String
  periodYYYYMM String
  ordersProcessed Int @default(0)
  @@id([shopId, periodYYYYMM])
}

model MockOutbox {                            // DEV/TEST ONLY: what mocks "sent"
  id         String @id @default(cuid())
  channel    String
  to         String
  payload    Json
  deliveryId String?
  createdAt  DateTime @default(now())
}
```

Retention (§Phase 8): prune `Delivery` rows, `ProviderEvent`s, and `WebhookEvent.payload`
per plan (FREE 7d / STANDARD 90d / PRO unlimited). **`Alert` rows are never deleted** — they
are kept as skeletons (id, kind, ruleId, dedupeKey, orderId, firedAt; a few dozen bytes)
because every dedupe guarantee (reconciliation no-ops, refund/low-stock/digest idempotency)
rests on their uniques; pruning them would re-arm alerts for anything touched again. The log
UI renders skeleton alerts as "details expired". `WebhookEvent.orderId` likewise survives
payload pruning (reconciliation join key).

---

## 3. Env Vars & External Credentials

Legend: **BLOCKING** = a real value is required for that capability to work against the real
service; **MOCKABLE** = absence automatically selects the mock adapter; app is fully
functional locally. *Nothing blocks local development or CI.*

| Env var | Used for | Class | Mock/fallback strategy |
|---|---|---|---|
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | OAuth, session tokens, webhook HMAC | BLOCKING for real embedded auth & real webhooks; MOCKABLE for everything else | Default to `dev-key`/`dev-secret` in `.env.example`. Test harness signs webhook payloads with the same secret, so HMAC verification is exercised for real. UI loaders get a `DEV_SHOP_DOMAIN`-based bypass when `ALERTPROOF_AUTH_BYPASS=1` — **allowlist-gated**: arms only when `NODE_ENV === 'development'` (or vitest) AND the bypass var is explicitly set AND the Shopify secret is the placeholder value; a real `SHOPIFY_API_SECRET` disarms it regardless of NODE_ENV. Same gate covers `dev.mock`. |
| `SHOPIFY_APP_URL`, `SCOPES` | Template config | MOCKABLE | `http://localhost:3000`; scopes `read_orders,write_orders,read_products,read_inventory` **[verify at build time]**. |
| `DATABASE_URL` | Postgres | Required but **locally satisfiable** (not an external credential) | `docker-compose up -d` provides it; `.env.example` ships the matching URL. No SQLite fallback (Json columns). |
| `TEST_DATABASE_URL` | Integration tests | Optional | Integration suites `describe.skipIf(!process.env.TEST_DATABASE_URL)`. Unit + e2e-pipeline tests run without it via in-memory repos? No — e2e-pipeline is an integration test; CI job spins up Postgres service container. |
| `POSTMARK_API_TOKEN` | Real email send | MOCKABLE | Absent → `MockEmailProvider` (MockOutbox + synthetic delivered event after 1s in dev). |
| `POSTMARK_WEBHOOK_SECRET` (or basic-auth user/pass on the callback URL) | Authenticating inbound Postmark status callbacks | MOCKABLE | Absent → callback route accepts only mock-signed events from `dev.mock` route. **[verify at build time]** Postmark's current webhook auth mechanism. |
| `EMAIL_FROM` | From address | MOCKABLE | Default `alerts@alertproof.test`. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | App-level SMS (Pro) | MOCKABLE | Absent → `MockSmsProvider`. Note: BYO-Twilio creds are *merchant data* (stored encrypted on Shop settings), not env — mock applies there too. |
| Slack / Discord webhook URLs | Delivery channels | Not env — merchant-entered per Recipient | `mock://` URLs route to `MockChatProvider`; real URLs use `fetch`. No credentials needed to build. |
| `CRON_SECRET` | Auth for `/internal/cron/*` | Locally generatable | Any random string; `.env.example` ships one. |
| `ALERTPROOF_ENCRYPTION_KEY` | AES-256-GCM for stored webhook URLs / BYO Twilio creds | Locally generatable | 32-byte base64; `.env.example` ships a dev key with a loud "rotate for prod" comment. |
| `ALERTPROOF_FORCE_MOCKS` | Force mock adapters even when creds present | Dev/test convenience | — |
| `DISABLE_WORKER` | Turn off in-process worker (e.g. during some tests) | Dev/test convenience | — |
| Fly.io/Railway tokens, Partner dashboard config, App Store listing | Deploy/distribution | BLOCKING, human-only | Documented in `docs/GOING_LIVE.md` (Phase 8); no code depends on them. |

**Count: 2 blocking credentials** (the Shopify API key/secret pair — and only for live OAuth
+ live webhooks; deploy tokens are human-only ops, not app config) — **everything else
(7 credential-ish vars) is mockable**, plus 5 locally-satisfiable/dev-convenience vars.

---

## 4. Phases

### Phase 0 — Scaffold, config, DB, ports skeleton, CI

**Goal:** Running app skeleton with Postgres/Prisma schema migrated, validated env, all port
interfaces + mock adapters stubbed, seed data, tests + CI green — the foundation every later
phase imports.

**Files:** everything under §1.3 that is scaffold/infra: template init, `docker-compose.yml`,
`.env.example`, `prisma/schema.prisma` (full §2 schema in one migration), `prisma/seed.ts`,
`app/lib/env.server.ts`, `app/lib/crypto.server.ts`, `app/lib/ports/index.ts`,
`app/lib/adapters/index.server.ts` + all mock adapters (real adapters as typed stubs that
throw `NotConfiguredError`), `tests/helpers/*`, `.github/workflows/ci.yml`.

**Key notes:**
- `shopify app init` with the React Router template; if the CLI requires Partner login to
  init, fall back to `git clone` of `Shopify/shopify-app-template-react-router` + manual
  `npm install` — do not block. Swap Prisma datasource to Postgres, delete SQLite artifacts.
- `env.server.ts`: zod schema; every var from §3 with defaults; export a typed `env` object
  and a `mode` report (`{email: 'mock'|'postmark', sms: ..., billing: ...}`) surfaced later
  in the settings UI.
- Adapter factory returns mocks per §3 rules. Mocks are real code (MockOutbox writes), not
  `TODO`s.
- CI: Postgres service container; jobs: lint, typecheck, `prisma migrate deploy` against the
  service DB, `vitest run` with `TEST_DATABASE_URL` set.
- Windows dev note in README snippet: docker compose or a native Postgres both fine.

**External deps touched:** `DATABASE_URL` (docker), placeholder Shopify keys. All mocks.

**Tests:** env validation (bad/missing vars fail loudly); crypto round-trip; adapter factory
selection matrix (env present/absent/`FORCE_MOCKS`); `MockEmailProvider.send` writes
MockOutbox; migration applies cleanly on fresh DB (CI does this implicitly).

**Acceptance:** `docker compose up -d && npm run setup && npm run dev` serves the app shell
locally with placeholder creds; `npm test` and CI green; `prisma migrate dev` idempotent;
seed creates shop/rules/recipients.

---

### Phase 1 — Webhook ingest: queue, fast ack, idempotent async processing

**Goal:** Shopify webhooks are verified, persisted to `WebhookEvent` in <150ms, acked, then
processed asynchronously with retries, backoff, and dead-lettering. Duplicate webhook IDs are
no-ops. This is the reliability core; it lands before any business logic.

**Files:** `app/routes/webhooks.shopify.tsx`, `app/lib/ingest/enqueue.server.ts`,
`app/lib/ingest/processor.server.ts`, `app/lib/ingest/worker.server.ts`, worker bootstrap in
`entry.server.tsx`, `app/routes/internal.cron.$job.tsx` (with `dispatch` job = drain queue),
`shopify.app.toml` webhook subscriptions, `tests/helpers/webhook-signer.ts`.

**Key notes:**
- Use the template's `authenticate.webhook(request)` for HMAC verification; it exposes
  `topic`, `shop`, `payload`, and `webhookId` **[verify at build time — if `webhookId` isn't
  exposed, read the `X-Shopify-Webhook-Id` header directly]**.
- Subscribe (in `shopify.app.toml`): `orders/create`, `orders/paid`, `refunds/create`,
  `inventory_levels/update`, `app/uninstalled`, plus mandatory compliance topics
  `customers/data_request`, `customers/redact`, `shop/redact`. For PAYMENT_FAILED, plan on
  `order_transactions/create` filtered to `status: failure` **[verify at build time — topic
  name and availability]**; if unavailable, derive from `orders/create` financial_status and
  note the limitation.
- Route handler does ONLY: verify → `enqueue()` (`INSERT ... ON CONFLICT (shopifyWebhookId)
  DO NOTHING` via `prisma.$executeRaw` or `createMany skipDuplicates`) → fire-and-forget
  `processPending()` kick → `200`. No rule logic in the request path. `enqueue()` extracts
  `WebhookEvent.orderId` from the payload for order-scoped topics (orders/*, refunds/create
  → `payload.order_id`, order_transactions/create → `payload.order_id`) — this column is the
  reconciliation join key and must be populated from day one. Compliance topics get
  minimal handlers (log + 200; data-request returns stored-data summary later).
- **Shop provisioning lands here** (no other phase owns it): the template's `afterAuth` hook
  upserts `Shop` on install — sets `installedAt`, `trialEndsAt = installedAt + 14d`,
  `reconcileCursor = installedAt`, and fetches `timezone` via the `ShopifyAdmin` port (mock
  returns a fixture shop). Webhook registration is `shopify.app.toml`-driven. Defensive
  fallback: a webhook arriving for an unknown `shopDomain` lazily upserts a minimal Shop row
  (covers races and the mock/bypass path, where the seed provides the shop).
- Processor: claim batch with `FOR UPDATE SKIP LOCKED` in a short transaction (mark
  `PROCESSING`, commit, then run the handler *outside* the claim transaction), call a
  **topic-handler registry** (Phase 1 registers a no-op handler that just marks PROCESSED —
  Phase 2 replaces it). On error: `attempts++`, exponential backoff
  (`nextAttemptAt = now + min(30 · 2^attempts, 3600)s`), status `FAILED` (still retryable);
  `DEAD` after 15 attempts (~12h of retrying — a transient provider/DB outage must NOT
  dead-letter events in minutes). Stuck-`PROCESSING` events older than 10 min are reclaimed
  (crash safety) and the reclaim **counts as an attempt** (`attempts++`, backoff applies) so
  a handler that crashes the worker can't reclaim-loop forever. Handlers must finish well
  inside the reclaim window (bound any Admin-API pagination); duplicate concurrent
  processing after a reclaim race is safe — at-least-once + Alert uniques.
- `DEAD` is an alarm, not a grave: expose DEAD count via `/healthz` and the dashboard
  (Phase 5), and provide a requeue action (reset to PENDING, attempts=0) on `dev.mock` /
  an internal route. Never silently expire DEAD events while a merchant could still care.
- `app/uninstalled`: mark `Shop.uninstalledAt`, disable rules; keep data for retention window.

**External deps:** `SHOPIFY_API_SECRET` (placeholder works — tests sign with it). Mock
strategy: `tests/helpers/webhook-signer.ts` builds a `Request` with valid HMAC for any
payload fixture; a dev-only `npm run fire-webhook -- orders/create fixtures/order1.json`
script posts to localhost.

**Tests:** HMAC reject (401) on bad signature; duplicate `shopifyWebhookId` → single row;
`orderId` extracted per topic (incl. refunds/transactions where it's `payload.order_id`);
ack-before-processing (route returns before handler runs — assert via handler spy); retry
schedule (30·2^n capped at 1h) + DEAD only after 15 attempts; concurrent workers don't
double-claim (two parallel `processPending()` on same rows — integration test);
stuck-PROCESSING reclaim increments `attempts` and eventually reaches DEAD; afterAuth upsert
sets installedAt/trialEndsAt/reconcileCursor/timezone; unknown-shop webhook lazily creates
the Shop row.

**Acceptance (no live creds):** `npm run fire-webhook` twice with same webhook id → one
`WebhookEvent`, status `PROCESSED`; a handler that throws leaves the event `FAILED` with
`nextAttemptAt` in the future and it later succeeds when the handler is fixed; ingest route
p50 latency logged <150ms locally.

---

### Phase 2 — Rules engine

**Goal:** Processed webhook events are evaluated against the shop's rules; matches create
idempotent `Alert` rows with resolved recipient×channel `Delivery` rows in `PENDING` (no
sending yet).

**Files:** `app/lib/rules/triggers.ts`, `app/lib/rules/evaluate.server.ts`, topic handlers
registered into the Phase-1 registry (`orders-create.handler.ts`, etc.),
`tests/fixtures/` (realistic Shopify payloads for each topic: normal order, high-value order,
order containing target product, refund, inventory level, failed transaction).

**Key notes:**
- `evaluate` is **pure**: `(trigger, extractedFacts, rules[]) -> matchedRules[]` — trivially
  unit-testable. Extractors per topic map raw payload → typed facts
  (`{orderId, orderName, totalPrice, lineItemProductIds, ...}`).
- Trigger semantics: `ORDER_CREATED` fires on orders/create; `ORDER_PAID` on orders/paid;
  `ORDER_VALUE_GTE` on orders/create with `total_price >= conditions.minValue`;
  `PRODUCT_ORDERED` on orders/create when line-item product ids intersect
  `conditions.productIds` (collection membership needs an Admin API lookup → goes through
  `ShopifyAdmin` port, `MockShopifyAdmin` seeded in tests; cache per shop, 10 min);
  `LOW_STOCK` on inventory_levels/update via **crossing detection against `InventoryState`**:
  load/upsert `(shopId, inventoryItemId, locationId)`, compare `lastAvailable` vs new
  `available` — fire only on a downward crossing of `stockThreshold`; when stock recovers
  above the threshold, increment `epoch` (no alert). dedupeKey =
  `{ruleId}:low_stock:{item}:{location}:{threshold}:{epoch}` — one alert per actual
  crossing, and the alert **re-arms after recovery** (a plain per-item key would suppress
  every future crossing forever);
  `REFUND_CREATED` on refunds/create with dedupeKey per **refund id** (a second partial
  refund on the same order must alert — never key refunds on orderId);
  `PAYMENT_FAILED` per Phase 1 note, dedupeKey per transaction id. Extractors are the single
  owner of dedupeKey construction (see §1.4 formats).
- Alert creation transactional with Delivery-row creation; uniques from §1.4 enforce
  idempotency — catch unique-violation and treat as success (already handled).
- Delivery rows are created per (recipient, channel) from `RuleRecipient.channels`,
  filtered by what the recipient has configured (no email address → `SKIPPED` with reason).
  Plan gating hooks exist but everything is allowed until Phase 6 (feature-flag function
  returns permissive defaults).
- Free-tier `UsageCounter` incremented per order-scoped event (enforcement in Phase 6).

**External deps:** `ShopifyAdmin` port for collection membership — mocked. No new env vars.

**Tests:** evaluate() table-driven per trigger (match/no-match/edge: equal threshold,
multi-currency string prices, missing fields); low-stock crossing sequence (drop below →
fires; further drop → no; recover above → epoch++ no alert; drop again → fires again);
two refunds on one order → two alerts; reprocessing same event creates no duplicate
Alerts/Deliveries; recipient with no channel data → SKIPPED; end-to-end: fire orders/create
fixture → assert Alert + N PENDING Deliveries.

**Acceptance:** With seeded rules, `npm run fire-webhook orders/create big-order.json`
produces exactly the expected Alert + Delivery rows (visible via `prisma studio` or a debug
route); firing it again produces nothing new.

---

### Phase 3 — Delivery adapters (email/Slack/Discord), dispatcher, delivery log statuses

**Goal:** PENDING deliveries are actually sent through channel adapters, provider status
callbacks update them, and the full delivery-log data (the moat) is populated end to end —
all against mocks by default.

**Files:** `app/lib/delivery/dispatch.server.ts`, `app/lib/delivery/templates.server.ts`,
`app/lib/delivery/status.server.ts`, real adapter implementations
(`adapters/email/postmark.server.ts`, `adapters/chat/slack.server.ts`,
`adapters/chat/discord.server.ts`) alongside the Phase-0 mocks,
`app/routes/webhooks.email-status.tsx`, `app/routes/dev.mock.tsx`,
`tests/e2e-pipeline.test.ts`.

**Key notes:**
- Dispatcher runs from the worker loop after rule handling and from the `dispatch` cron job:
  claim PENDING deliveries (same SKIP LOCKED pattern), conditional-UPDATE to `SENDING`
  (§1.4), render template, call adapter, store `providerMessageId`, set `SENT` (+`sentAt`);
  Slack/Discord return success synchronously → mark `DELIVERED` immediately. Adapter error →
  retry with backoff (attempts on Delivery), `FAILED` after 5.
- **Stuck-SENDING sweep** (same loop/cron): `SENDING` rows older than 10 min → `attempts++`,
  back to `PENDING` (or `FAILED` at max). A crash between the SENDING flip and the provider
  call must not strand a delivery forever. Document at-least-once explicitly: a crash *after*
  the provider call may re-send on retry — duplicate sends are acceptable, drops are not.
- Templates: email (subject + minimal HTML: order name, value, items, link to order admin),
  Slack Block Kit, Discord embed. Keep in one file, snapshot-tested.
- Postmark adapter: send via API with `MessageStream=outbound`, capture `MessageID`. Status
  route parses Delivery/Bounce/Deferred webhook payloads → `ProviderEvent` row →
  `status.server.ts` maps to Delivery by `providerMessageId` and updates status/`statusAt`
  (append raw payload into `providerDetail`). Unknown `providerMessageId` → store
  ProviderEvent, log, 200 (never 5xx a provider callback).
- `MockEmailProvider` in dev emits a synthetic Delivered callback ~1s later (via the same
  status route) so the log shows the full lifecycle locally; `dev.mock.tsx` lists MockOutbox
  and has buttons "simulate bounce/delivered" per message — this becomes the demo tool.
- Encrypt Slack/Discord URLs at rest (crypto.server.ts) when recipients are saved (route
  comes in Phase 5; helper functions land now).

**External deps:** `POSTMARK_API_TOKEN` (MOCKABLE — absent selects mock),
`POSTMARK_WEBHOOK_SECRET` (MOCKABLE), `EMAIL_FROM`. Slack/Discord: merchant URLs;
`mock://` scheme routes to mock provider.

**Tests:** dispatcher idempotency (concurrent dispatch of same Delivery sends once);
stuck-SENDING sweep re-queues with attempts++ (fake clock) and FAILs at max;
adapter error → retry → FAILED path; template snapshots per channel; status mapping
(Bounce→BOUNCED, Delivery→DELIVERED, Deferred→DEFERRED, out-of-order events don't regress
DELIVERED); unknown messageId tolerated; **e2e-pipeline.test.ts**: signed orders/create
request → queue → rules → dispatch → MockOutbox rows → simulated Postmark callbacks →
Delivery rows terminal — the single test that proves the brand promise.

**Acceptance:** Locally with zero creds: fire a webhook, watch `dev.mock` show the email +
Slack + Discord payloads, click "simulate bounce", and see the Delivery row go BOUNCED with
timestamps. e2e-pipeline test green in CI.

---

### Phase 4 — Order write-back + reconciliation cron

**Goal:** (a) Each order gets a metafield + order note summarizing alert/delivery status,
visible in Shopify admin. (b) A 15-minute reconciliation cron polls the Orders API and feeds
any missed orders through the identical pipeline.

**Files:** `app/lib/writeback/order.server.ts`, `app/lib/reconcile/reconcile.server.ts`,
`adapters/shopify-admin/real.server.ts` (Admin GraphQL: orders query by `updated_at`,
`metafieldsSet`, order note/timeline update — **[verify at build time]** current mutation
names and whether timeline comments need extra scope; fall back to appending to the order
`note` field), extend `MockShopifyAdmin`, wire `reconcile` job into
`internal.cron.$job.tsx`, extend worker loop to run reconcile on interval for dev.

**Key notes:**
- Write-back runs when an Alert's deliveries reach terminal states (and updates again on
  later status changes, debounced ~60s): metafield namespace `alertproof`, key `status`,
  JSON `{alerts: n, delivered: n, bounced: n, lastUpdate}`; note line like
  `AlertProof: 3/3 alerts delivered (email x2, slack x1)`. Write-back failures never block
  the pipeline — they get their own small retry (a `writebackPending` flag or reuse queue
  with a synthetic event).
- Reconciliation per shop — the exact algorithm (get this right; it is the headline claim):
  1. `cursor = shop.reconcileCursor` (initialized to `installedAt` at install — never null).
  2. Query orders `updated_at >= cursor − 5min overlap` (paginated, respect Admin API rate
     limits via the client's built-in retry **[verify at build time]**). `updated_at` (not
     `created_at`) so late events — an old order getting paid/refunded today — are caught.
  3. **Skip any order with `created_at < shop.installedAt`** — Shopify bumps `updated_at` on
     any edit (tags, fulfillment), and pre-install orders must never generate alerts.
  4. For each remaining order, derive the **expected event set** from order state:
     `orders/create` always; `orders/paid` iff `financial_status` ∈ paid-like states;
     `refunds/create` once **per refund id** in `order.refunds`. Check each expected
     (topic, id) against `WebhookEvent(shopDomain, topic, orderId)` — an indexed column
     lookup, never a payload parse. A dropped `orders/paid` on an order whose
     `orders/create` arrived IS detected (the check is per topic, not per order).
  5. For each missing expected event, synthesize a `WebhookEvent`
     (`source=RECONCILIATION`, synthetic id per §1.4 — **no time bucket**, so re-scanning
     the same order in a later run can never re-insert; and the durable Alert dedupe makes
     re-alerting impossible even where an event row predates the check).
  6. Record `ReconciliationRun` with `missedFound`; on success set
     `shop.reconcileCursor = runStartedAt` (cursor unchanged on any error — crash-safe).
- Reconciliation covers orders (create/paid/refunds via order financial status); it cannot
  recover inventory_levels history — document that LOW_STOCK relies on webhooks alone.
- Cron endpoint auth: `Authorization: Bearer ${CRON_SECRET}`, constant-time compare.

**External deps:** Admin API via port (mock has a seedable in-memory order store + records
mutations). `CRON_SECRET` (local). No live creds needed: integration tests seed
`MockShopifyAdmin` with orders that have no corresponding WebhookEvent and assert the
pipeline produces Alerts for them.

**Tests:** reconcile finds a seeded "missed" order → synthetic event → Alert created; already
-alerted orders produce nothing; **order with orders/create present but orders/paid missing →
only the paid event is synthesized**; **pre-install order edited recently → skipped, no
alert**; second refund on an already-reconciled order → one new refund event; running
reconcile twice back-to-back → zero new events on the second run; cursor advances/overlap
window correct with fake clock; crash mid-run doesn't lose orders (cursor unchanged on
error); metafield/note payload snapshots; write-back retry on mock admin failure; cron route
401 without secret.

**Acceptance:** In a local session: seed a mock order with no webhook, hit
`POST /internal/cron/reconcile` with the secret, and the delivery log shows the alert with
`source=RECONCILIATION`; MockShopifyAdmin records the metafield + note writes with correct
JSON.

---

### Phase 5 — Embedded Polaris UI: settings, rules, recipients, delivery log, "test my alerts"

**Goal:** The full merchant-facing embedded UI: onboarding dashboard, rules CRUD, recipients
CRUD, searchable delivery log, settings, and the "test my alerts" button that fires a fake
order through the entire real pipeline.

**Files:** all `app/routes/app.*` routes from §1.3, shared UI components
(`app/components/`: `StatusBadge`, `ChannelIcons`, `EmptyState`s, `OnboardingChecklist`),
loader/action modules calling the same server libs phases 1–4 built.

**Key notes:**
- Auth: template's `authenticate.admin(request)` in every loader/action. For credential-less
  dev, `ALERTPROOF_AUTH_BYPASS=1` + `DEV_SHOP_DOMAIN` short-circuits to the seeded shop.
  The guard is an **allowlist, not a denylist**: bypass arms only when
  `NODE_ENV === 'development'` (or vitest) AND `ALERTPROOF_AUTH_BYPASS=1` AND
  `SHOPIFY_API_SECRET` is the placeholder value — a real secret disarms it regardless of
  NODE_ENV (an unset/`staging` NODE_ENV must never leave the admin UI open). Loud startup
  banner when armed; same gate on `dev.mock`. This is the documented way agents and
  reviewers run the UI without Partner creds; real OAuth is exercised later on a dev store.
- Use the template's current UI kit (Polaris web components or React Polaris — keep whatever
  the scaffold uses **[verify at build time]**; don't mix).
- Rules pages: trigger picker with conditional condition fields (min value, product picker —
  use the ResourcePicker via App Bridge when real, a plain ID text input under auth bypass),
  recipient×channel matrix. Server-side zod validation shared with API.
- Delivery log: filter by order name/status/channel/date; row expands to per-delivery
  timeline (sent→delivered/bounced with timestamps + provider detail); link to the order in
  Shopify admin. Pagination cursor-based on `firedAt`.
- **Test my alerts:** action creates a synthetic orders/create `WebhookEvent`
  (`source=TEST`, fake order name `#TEST-{ts}`) → the real queue/rules/dispatch path — zero
  special-case code beyond the source tag and exclusion from usage counters/write-back.
  The result panel polls the log and shows each delivery going green. In mock mode this
  completes fully (mock auto-delivers), which is exactly the demo.
- Dashboard: onboarding checklist (create a rule → add a recipient → run a test alert),
  headline stats (alerts sent 7d, delivery rate, last reconciliation missed-count, and a
  **DEAD-event count with a warning banner + requeue link when nonzero** — dead-letters must
  be visible, per Phase 1), and the adapter `mode` report ("Email: MOCK MODE — set
  POSTMARK_API_TOKEN to go live") so the going-live path is self-documenting.

**External deps:** none new; UI runs entirely on mocks + auth bypass.

**Tests:** loader/action unit tests (validation failures, happy paths) with seeded DB;
rules CRUD round-trip integration test; delivery-log filter query tests; test-alert action
produces TEST-source pipeline rows; auth-bypass allowlist matrix (arms only with
development+flag+placeholder secret; refuses with real secret, with `NODE_ENV` unset, and
with `NODE_ENV=production`).
(Playwright browser tests optional — do not add the dependency unless cheap; assert via
loader/action level otherwise.)

**Acceptance:** `npm run dev` with bypass: create a rule + recipient in the UI, click "Test
my alerts", watch the log page show sent→delivered rows within seconds, all against mocks.

---

### Phase 6 — Billing + plan gating

**Goal:** Free/Standard($9)/Pro($19) plans enforced everywhere, Shopify Billing API
subscription flow behind the `BillingService` port, 14-day trial, free-tier caps live.

**Files:** `app/lib/billing/plans.server.ts` (single source of truth:
`PLAN_FEATURES = {FREE: {maxRules:1, channels:['EMAIL'], retentionDays:7, ordersPerMonth:50},
STANDARD: {...90d...}, PRO: {sms, escalation, digest, unlimited}}`),
`adapters/billing/{shopify,mock}.server.ts`, `app/routes/app.billing.tsx`, gating enforcement
edits in: rules CRUD (max rules), delivery creation (channel allowed → else SKIPPED with
`reason: plan`), usage counter check in order handlers (over cap → Alert created with all
deliveries SKIPPED `reason: over_free_limit` — never silently drop; the log honestly shows
what wasn't sent and why, which is on-brand), retention values for Phase 8 pruning.

**Key notes:**
- Real adapter: the app package's billing helpers (`billing.require`/`billing.request` with
  `LineItem`/recurring config **[verify at build time]** — the billing API surface moved
  between template versions). `test: true` charges when `NODE_ENV !== 'production'`.
- Mock adapter: `requestSubscription` immediately "activates" and sets `Shop.plan`;
  `app.billing` page renders identically. A dev-only plan switcher on that page under
  `FORCE_MOCKS`.
- Trial: `trialEndsAt` is already set by Phase 1's afterAuth provisioning
  (`installedAt + 14d`); this phase only consumes it — during trial everything behaves as
  STANDARD.
- Gating is checked **server-side in lib code**, UI reflects it (disabled options with
  upgrade CTA) but is never the enforcement point.

**External deps:** Shopify Billing API — mockable per above; needs real Partner creds only
for a live charge test on a dev store (note in GOING_LIVE.md).

**Tests:** gate matrix per plan (rules cap, channel filtering, usage cap) unit-tested against
`plans.server.ts`; over-cap order produces SKIPPED deliveries with reason (integration);
trial-active behaves as STANDARD (fake clock); mock billing upgrade flow flips plan and
unlocks a previously-SKIPPED channel.

**Acceptance:** Locally: on FREE, a rule routed to Slack shows SKIPPED(plan) in the log;
"upgrade" via mock billing → re-fire → Slack delivery goes through. 51st order in a month on
FREE logs SKIPPED(over_free_limit).

---

### Phase 7 — Pro features: SMS (Twilio), escalation/re-send, daily digest

**Goal:** The Pro tier: SMS channel (app-level or BYO-Twilio), escalation (bounce or
non-delivery within N minutes → re-send on backup channel), and per-recipient daily digest.

**Files:** `adapters/sms/twilio.server.ts` (mock exists since Phase 0),
`app/routes/webhooks.sms-status.tsx` (Twilio status callbacks → ProviderEvent → Delivery),
`app/lib/escalation/escalate.server.ts` + `escalate` cron job,
`app/lib/digest/digest.server.ts` + `digest` cron job, settings UI additions
(BYO-Twilio creds fields — encrypted via crypto.server.ts; per-recipient digest toggle/hour;
per-rule escalation config), `plans.server.ts` already gates all three.

**Key notes:**
- Escalation scan (cron, every minute in worker loop): deliveries where
  `(status=BOUNCED) OR (status IN (SENT,DEFERRED) AND sentAt < now − rule.escalation.afterMinutes)`
  and rule has escalation → create new Delivery `isEscalation=true` on the configured backup
  channel → normal dispatcher sends it. Duplicate prevention is the **DB constraint**
  `Delivery.escalatedFromId @unique` (§2), not a read-check: concurrent/overlapping cron
  runs hit the unique violation, which is caught and treated as already-escalated. Never a
  "check then insert" without the constraint. Escalations never escalate (no chains —
  `isEscalation=true` rows are excluded from the scan). PLAN's "not opened within N minutes"
  is scoped to "not *delivered* within N minutes" for MVP (open tracking = post-MVP; note in
  code comment).
- Twilio: validate callback signature (`X-Twilio-Signature`) when real creds present; store
  `MessageSid` as providerMessageId; map queued/sent/delivered/undelivered/failed statuses.
  BYO creds resolved per shop at send time (decrypt), falling back to app-level env creds,
  falling back to mock.
- Digest: hourly cron; for each recipient with `digestEnabled` where
  `localHour(shop.timezone) == digestHourLocal` and no digest sent in last 20h: compile last
  24h (orders alerted, deliveries by status, bounces highlighted) → send as a normal EMAIL
  Delivery attached to an `Alert` row with `kind=DIGEST`, `ruleId=null`,
  `webhookEventId=null` (the schema's nullable FKs + `AlertKind` exist for exactly this —
  do NOT invent fake rules/events), `dedupeKey = digest:{recipientId}:{date}` (shop-local
  date) — the `(shopId, dedupeKey)` unique makes the cron idempotent by design.

**External deps:** `TWILIO_*` (MOCKABLE). Mock SMS auto-emits a delivered receipt in dev.

**Tests:** escalation trigger matrix with fake clock (bounce→escalate; SENT past window→
escalate; DELIVERED→no; already-escalated→no; no chains); Twilio status mapping + signature
reject; digest hour/timezone selection (table across timezones + DST edge), digest idempotency
(run cron twice → one digest); digest content snapshot; BYO-creds resolution order.

**Acceptance:** Locally: rule with escalation `{afterMinutes:10, channel:SLACK}` → fire order
→ simulate email bounce in `dev.mock` → run escalate cron → Slack (mock) delivery appears
flagged "escalation". Digest cron at the right fake hour yields one digest email in
MockOutbox with correct counts.

---

### Phase 8 — Hardening, retention, docs, deploy readiness

**Goal:** Production-quality close-out: retention pruning, compliance webhook substance,
observability, load/perf sanity, deploy artifacts, and the going-live runbook.

**Files:** `app/lib/retention/prune.server.ts` + `prune` cron job; flesh out GDPR handlers
(customers/data_request → compile stored data for that customer [we store little: order
ids/names in Alerts], customers/redact + shop/redact → scrub/delete rows);
structured logging (pino or console-JSON) with event ids throughout ingest/dispatch;
`/healthz` route (DB ping + queue depth + oldest-pending age); `Dockerfile` + `fly.toml`
(and/or `railway.json`) with worker + cron schedule config; `docs/GOING_LIVE.md`;
README update (dev quickstart, mock-mode explanation); dependency/audit pass.

**Key notes:**
- Pruning per plan retention: delete `Delivery` rows and `ProviderEvent`s past the window;
  **never delete `Alert` rows** — keep them as skeletons (null out display-only fields if
  desired, keep id/kind/ruleId/dedupeKey/orderId/firedAt) because reconciliation no-ops,
  refund/low-stock/digest idempotency all rest on the Alert uniques; pruning them re-arms
  old alerts (see §1.4). Log UI shows skeleton alerts as "details expired". Null out
  `WebhookEvent.payload` after 30d (keep the row *and its `orderId`* — idempotency and
  reconciliation history), delete DEAD events after 90d (they've been surfaced on the
  dashboard since Phase 5; deletion is safe because Alert dedupe is durable). Batch deletes
  (limit 1000/loop) to avoid long locks.
- `GOING_LIVE.md` is the credential handoff contract: exact steps to (1) create the Partner
  app + set `SHOPIFY_API_KEY/SECRET`, run real OAuth on a dev store; (2) set
  `POSTMARK_API_TOKEN` + configure Postmark webhook URL to `/webhooks/email-status`;
  (3) Twilio; (4) `fly launch` / Railway with secrets + external cron hitting
  `/internal/cron/*`; (5) billing live-test; (6) App Store review checklist (compliance
  webhooks, privacy policy URL, embedded checks). Every **[verify at build time]** item left
  unresolved gets listed here explicitly.
- Perf sanity test: enqueue 500 events, assert full drain < 60s locally and ingest route
  stays <150ms p50 under concurrent fire (simple script, not a benchmark suite).
- Final pass: ensure no adapter import leaks outside `adapters/`, no secret is ever logged,
  auth-bypass and `dev.mock` routes are hard-disabled in production builds.

**External deps:** none for code; deploy tokens documented as human-only.

**Tests:** retention pruning per plan with fake clock (7d/90d/unlimited) — Deliveries gone,
Alert skeletons + dedupe uniques intact, `WebhookEvent.orderId` intact after payload null,
reconciliation after pruning still produces zero re-alerts; redact handlers
scrub correctly; healthz shape; the perf script wired as an opt-in npm script (not CI-gating).

**Acceptance:** Full CI green; `docker build` succeeds; a fresh clone with only
`docker compose up` + `.env.example` copied reaches a working end-to-end demo (rule → test
alert → log → simulated bounce → escalation) following README steps alone; `GOING_LIVE.md`
enumerates every credential with its insertion point.

---

## 5. Open Questions / Risks

1. **Template drift.** The React Router template and `@shopify/shopify-app-react-router`
   move fast (webhook helper surface, billing helpers, Polaris web components vs React
   Polaris, route-file conventions). Phase 0 must adopt whatever the scaffold generates and
   record deviations from this plan in a short `docs/DECISIONS.md` note rather than fighting
   the template.
2. **PAYMENT_FAILED trigger source.** `order_transactions/create` topic availability/shape is
   the least-certain webhook choice — verify; the fallback (infer from order financial
   status) is weaker and should be labeled in the UI if used.
3. **Order note vs. timeline comment.** Writing to `order.note` overwrites a merchant-visible
   free-text field (merchants may use it). Prefer a metafield (+ optionally a timeline
   comment via `orderEditBegin`-adjacent APIs if scope-cheap **[verify]**); if only `note` is
   feasible, append-not-replace and make it a setting (off by default?to decide in Phase 4).
4. **OAuth cannot be fully verified without Partner creds.** The auth-bypass path means the
   embedded UI is built "blind" against real session-token auth; budget for fixes on first
   real dev-store run (most common breakage: App Bridge config, CSP/frame headers — the
   template handles these, but verify).
5. **Reconciliation blind spot.** Inventory-level history isn't pollable the same way orders
   are — LOW_STOCK reliability depends on webhook delivery alone. Acceptable for MVP;
   document honestly (the reliability claim in marketing is about *order* alerts).
6. **Postgres-as-queue ceiling.** Fine to thousands of orders/day/shop; if a big merchant
   lands, the `WebhookEvent` claim query is the first thing to index-tune or move to a real
   queue. Not an MVP concern; the schema doesn't preclude it.
7. **Postmark inbound-webhook auth mechanism** (basic auth on URL vs. signature header) —
   verify at build time; the port's `verifyStatusWebhook` isolates whichever it is.
8. **Free-tier abuse / cost control.** Mock-mode makes this invisible during build; before
   launch set Postmark sending caps and per-shop daily send ceilings (Phase 8 note in
   GOING_LIVE.md).
9. **App review requirements** (mandatory compliance webhooks, privacy policy, billing test
   charges) change periodically — GOING_LIVE.md carries the checklist; re-verify at
   submission time.

---

## Review revisions (2026-07-20)

Adversarial review (`PLAN_REVIEW.md`: 3 BLOCKER / 10 MAJOR / 11 MINOR) — all BLOCKER and
MAJOR fixes are folded in above; MINORs remain listed in `PLAN_REVIEW.md` only. Summary of
what changed:

- **Reconciliation rewritten (B1–B3):** `WebhookEvent.orderId` column + index added
  (existence checks were unimplementable against JSON payloads); synthetic recon ids lose
  their time bucket (`recon:{shop}:{topic}:{orderId|refundId}` — one per resource, ever);
  reconciliation now checks a per-order **expected event set** per topic (dropped
  `orders/paid`/`refunds/create` are actually recovered); pre-install orders
  (`created_at < installedAt`) are never reconciled (Shopify bumps `updated_at` on any edit —
  this previously allowed false alerts for old orders); exact 6-step algorithm specced in
  Phase 4 with matching tests.
- **Dedupe made durable and per-resource (B2, M8, M10):** Alert unique is now
  `(shopId, dedupeKey)` with ruleId embedded in the key; refunds key on refund id (second
  partial refund must alert), payment-failures on transaction id; retention (Phase 8) never
  deletes Alert rows — skeletons persist so no pruned dedupe can re-arm an old alert.
- **Queue retry policy fixed (M1, M9):** backoff `min(30·2^n, 3600)s`, DEAD after 15
  attempts (~12h) instead of 8 attempts (~8.5 min); stuck-PROCESSING reclaim counts as an
  attempt (no infinite reclaim loops), window widened to 10 min; DEAD events surfaced on
  `/healthz` + dashboard with a requeue action.
- **Stuck-SENDING sweep added (M2):** Phase 3 dispatcher reclaims `SENDING` deliveries older
  than 10 min; at-least-once send semantics documented explicitly.
- **Escalation dedupe is a DB constraint (M3):** `Delivery.escalatedFromId` is `@unique`;
  Phase 7 forbids check-then-insert.
- **LOW_STOCK re-arms (M4):** new `InventoryState` table with `epoch`; alerts fire per
  downward crossing and re-arm on recovery instead of firing once per item per lifetime.
- **Digest fits the schema (M5):** `Alert.kind` (RULE|DIGEST) added, `ruleId`/
  `webhookEventId` nullable; digest idempotent via `digest:{recipientId}:{date}` dedupeKey.
- **Shop provisioning owned by Phase 1 (M6):** afterAuth upserts Shop
  (`installedAt`, `trialEndsAt`, `timezone`, `reconcileCursor`); lazy upsert on
  unknown-shop webhooks; Phase 6 consumes `trialEndsAt` instead of pointing at a
  nonexistent path.
- **Auth-bypass guard is an allowlist (M7):** arms only on
  development + explicit flag + placeholder Shopify secret; a real secret disarms it
  regardless of `NODE_ENV`; same gate on `dev.mock`; test matrix added in Phase 5.
