# Deployment & Live-Testing Handoff — Shopify SaaS Portfolio

**For:** Hermes agent (deployment/ops capable)
**From:** Claude Code orchestration session, 2026-07-20
**Goal:** take three built-and-hardened Shopify apps from "runs locally on mocks" to "live-testable on a real Shopify dev store," deployed to the Hostinger VPS behind the existing **Traefik** reverse proxy on **nickbolles.com** subdomains.

---

## 0. TL;DR / order of operations

1. **Human (Nick):** create a Shopify **Partner account** + one **development store**; for each app, create the app in the Partner Dashboard and copy its **Client ID + Client secret** into that app's git-ignored `.env` (see §4). *Never paste secrets into chat or commit them.*
2. **Hermes:** on the VPS, for each app: inject real env/secrets, run `docker compose up -d --build`, wire Traefik to the subdomain, run DB migrations.
3. **Human or Hermes-with-browser:** set each app's App URL + webhook URLs in the Partner Dashboard to the live subdomain, install on the dev store (approve OAuth in browser), toggle billing test.
4. **Hermes:** run the per-app smoke drills in §6.

Recommend doing **SKUForge first** (simplest: single web service + Postgres, no Redis/worker), then AlertProof, then CheckoutWatch (heaviest).

---

## 1. What these apps are (current state)

Three Shopify **React Router 7** embedded apps. All were built phase-by-phase, adversarially reviewed, gap-audited, and hardened. **All tests pass, all production builds pass, all Docker images build.** Each is architected mock-first: every external dependency sits behind a port/adapter, so the app runs and tests green with **zero credentials** — real creds are dropped in via env at deploy time.

| App | Repo (GitHub) | Local path | What it does |
|-----|---------------|-----------|--------------|
| **AlertProof** | `NickBolles/project-alertproof` | `C:\Users\nickb\Code\alertproof` | Reliable multi-channel staff order alerts + provider-confirmed delivery log |
| **CheckoutWatch** | `NickBolles/project-checkoutwatch` | `C:\Users\nickb\Code\checkoutwatch` | Synthetic Playwright checkout monitoring + AI failure diagnosis + status page |
| **SKUForge** | `NickBolles/project-skuforge` | `C:\Users\nickb\Code\skuforge` | SKU/barcode generation with a hard cross-job uniqueness guarantee + PDF labels |

Each repo has: `README.md`, `PLAN.md`, `IMPLEMENTATION_PLAN.md`, `PLAN_REVIEW.md`, a `GAP_REPORT.md` (audit findings + backlog), and a go-live doc (`docs/GOING_LIVE.md` / `docs/DEPLOYMENT.md` / `docs/GO_LIVE.md`) — **read the go-live doc per app; it is authoritative for env-var names and webhook paths.**

> ⚠️ **The #1 risk theme (from the gap audits):** these apps are thoroughly correct against *mocks*. The untested surface is everything that only runs against *live* Shopify / Redis / Postgres. AlertProof has a "production-shape adapter contract-test" suite as a template; expect the first real-store install to surface small shape mismatches. Budget time for that.

---

## 2. Target infrastructure

- **Host:** Hostinger VPS, Docker + Docker Compose, existing **Traefik** reverse proxy (Docker provider assumed — attach services to Traefik's network and use container labels).
- **DNS:** subdomains off `nickbolles.com`:
  - `alertproof.nickbolles.com`
  - `checkoutwatch.nickbolles.com`
  - `skuforge.nickbolles.com`
  - (optional) `status.nickbolles.com` → CheckoutWatch's public status page (same web service, path `/status/:slug`)
- **TLS:** Traefik + Let's Encrypt (already in place). Shopify **requires** HTTPS for the App URL and every webhook endpoint.
- **RAM:** CheckoutWatch's worker runs Chromium (image ~4 GB) — give the box ≥4 GB comfortably. AlertProof/SKUForge are light.

### Traefik routing (Docker-label pattern)
Attach each app's **web** container to the Traefik network and label it, e.g. for SKUForge:
```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.skuforge.rule=Host(`skuforge.nickbolles.com`)"
  - "traefik.http.routers.skuforge.entrypoints=websecure"
  - "traefik.http.routers.skuforge.tls.certresolver=<your-resolver>"
  - "traefik.http.services.skuforge.loadbalancer.server.port=3000"
```
Ports: **all web services listen on `:3000`.** CheckoutWatch's **worker** exposes `:3001` for health **only** — do NOT route it publicly; Traefik/health-check internal only.

---

## 3. Per-app deployment spec

### 3a. SKUForge (do first — simplest)
- **Topology:** 1 web service + Postgres. No Redis, no worker.
- **Image:** root `Dockerfile` (Node 20, `:3000`). *Builds clean (Dockerfile was fixed this session).*
- **⚠️ Missing artifact:** there is **no `docker-compose.yml`** yet. Hermes must create one: `web` (build `.`) + `postgres:16-alpine` + a persistent volume, on the Traefik network, with the labels above. Run `npm run db:deploy`-equivalent (`prisma migrate deploy` against Postgres) as the release step. Container start = `npm run docker-start` (already runs `prisma generate && prisma migrate deploy && serve`).
- **Cron:** schedule one **daily** `POST https://skuforge.nickbolles.com/api/cron/scan` with header `Authorization: Bearer $CRON_SECRET` (host cron, a scheduler container, or GitHub Actions). Must be idempotent per UTC day — verify by invoking twice.
- **Human gate:** `docs/GO_LIVE.md` requires a week-0 competitor audit before public listing (market check, not an engineering blocker for testing).

### 3b. AlertProof
- **Topology:** 1 always-on web service (runs web + in-process worker + crons) + Postgres. Postmark for email; optional Twilio for SMS.
- **Image:** root `Dockerfile` (`:3000`); `docker-compose.yml` already present (local Postgres) — adapt for prod (real DATABASE_URL, Traefik labels).
- **Must stay awake:** the single process runs dispatch (1 min), reconcile (15 min), escalate (1 min), digest (hourly), prune (daily). **Do not let it sleep** — it would drop webhook traffic, which defeats the product. If you prefer external scheduling, the cron routes exist (see §5b) guarded by `CRON_SECRET`.
- **Health:** `GET /healthz` returns DB status + queue depth + DEAD count.

### 3c. CheckoutWatch (heaviest — do last)
- **Topology:** `web` + one-or-more standalone **worker** (Playwright) + **Postgres** + **Redis**. `docker-compose.yml` already present and boots the full prod-parity stack (Postgres, Redis, fixture/control-probe, migrate, web, worker).
- **Images:** `apps/web/Dockerfile` (Node 20, `:3000`) and `apps/worker/Dockerfile` (**pinned Playwright 1.53.1 Jammy base**, health `:3001`). Both build the Postgres Prisma client at build time.
- **Critical prod settings (audit-fixed, keep them right):**
  - **Stable shared `QUEUE_PREFIX`** across every web+worker replica (default `checkoutwatch`). *Never* derive it from PID/container id — that was the fixed BLOCKER (web jobs never reached the worker).
  - **`CONTROL_PROBE_URL` must be a non-loopback, independently-hosted, known-good HTTPS endpoint.** Startup **rejects** a missing/loopback value in production. Ideally NOT the same box (so a box-wide outage doesn't blind the probe). A tiny always-up external 200 endpoint works.
  - `INLINE_WORKER=0` on both web and worker; run the worker via `pnpm worker`.
  - `ARTIFACT_STORE=local` + shared `ARTIFACT_DIR` works for a **single** durable worker only. **Multi-replica scaling needs an S3-compatible artifact-store adapter that is NOT yet built** — keep to one worker until then.
- **The compose defaults to MOCK Shopify + mock alert transports** (credential-free). To go live you must inject real creds and set `SHOPIFY_AUTH=real` / `ALERT_TRANSPORT=real`. The webhook verifier rejects mock signatures when `NODE_ENV=production` even in the compose topology.

---

## 4. Secrets & env (per app)

**Rules:** never commit secrets; never put them in a compose file or image layer; use the VPS secret store / env files with `chmod 600` and git-ignored. Generate a `.env` from each repo's `.env.example`. **Back up encryption keys independently** — losing one makes all stored encrypted secrets unreadable.

### SKUForge
`NODE_ENV=production`, `AUTH_MODE=shopify`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL=https://skuforge.nickbolles.com`, `SCOPES=read_products,write_products`, `DATABASE_URL` (Postgres), `CRON_SECRET` (high entropy), `BILLING_TEST=false` (set `true` only during the dev-store charge test). Do not rely on `MOCK_PLAN` in prod (mock auth is fail-closed regardless).

### AlertProof
`NODE_ENV=production`, `AUTH_MODE=shopify`, `ALERTPROOF_AUTH_BYPASS=0`, `ALERTPROOF_FORCE_MOCKS=0`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL=https://alertproof.nickbolles.com`, `DATABASE_URL` (Postgres 16 TLS), `CRON_SECRET` (≥32 random bytes), **`ALERTPROOF_ENCRYPTION_KEY`** (exactly 32 bytes, base64 — **BACK IT UP**; encrypts merchant webhook URLs + BYO-Twilio creds), `POSTMARK_API_TOKEN`, `EMAIL_FROM` (verified), `POSTMARK_WEBHOOK_SECRET=user:pass` (HTTP Basic on the email webhook). Optional app-funded SMS: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`.

### CheckoutWatch
`NODE_ENV=production`, `SHOPIFY_AUTH=real`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL=https://checkoutwatch.nickbolles.com`, `SHOPIFY_SCOPES=read_products,read_themes`, **`ENCRYPTION_KEY`** (32 bytes base64 — encrypts offline tokens; **BACK IT UP**), `DATABASE_URL` (Postgres), `REDIS_URL`, `QUEUE_DRIVER=bullmq`, `QUEUE_PREFIX=checkoutwatch`, `INLINE_WORKER=0`, `WORKER_HEALTH_PORT=3001`, `ENGINE_CONCURRENCY` (Chromium concurrency), **`CONTROL_PROBE_URL`** (non-loopback HTTPS). Alerts: `ALERT_TRANSPORT=real`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` (+ `/webhooks/resend`), optional `TWILIO_*` (+ `/webhooks/twilio`, Pro-only SMS). Diagnosis (optional): `ANTHROPIC_API_KEY`, `LLM_MODEL`, `DIAGNOSIS_PROVIDER=anthropic` (heuristic fallback otherwise). Artifacts: `ARTIFACT_STORE=local`, `ARTIFACT_DIR`. See `.env.example` for exact spelling of every var.

---

## 5. Shopify Partner wiring (per app)

For each app in the Partner Dashboard: set **App URL** = `https://<sub>.nickbolles.com`, set the OAuth callback / redirect URLs the RR7 template expects, request only the scopes listed above, then run `shopify app deploy` (needs an authenticated Shopify CLI — see §7) to register webhook subscriptions. Send an **invalid-HMAC probe** to each webhook path and confirm rejection (401).

### 5a. Webhook topics → paths
- **SKUForge** → paths in `shopify.app.toml`: `products/create`, `app/uninstalled`, `app/scopes_update`, `app_subscriptions/update`, `customers/data_request`, `customers/redact`, `shop/redact`.
- **AlertProof** → `/webhooks/shopify`: `app/uninstalled`, `orders/create`, `orders/paid`, `refunds/create`, `inventory_levels/update`, `order_transactions/create` + GDPR trio. Plus provider callbacks: `/webhooks/email-status` (Postmark), `/webhooks/sms-status` (Twilio).
- **CheckoutWatch** → `/webhooks/...`: `app/uninstalled`, `app_subscriptions/update`, GDPR trio. Provider callbacks: `/webhooks/resend`, `/webhooks/twilio`.

### 5b. AlertProof cron routes (if scheduling externally instead of the always-on loop)
`POST /internal/cron/dispatch` & `/internal/cron/escalate` (every min), `/internal/cron/reconcile` (15 min), `/internal/cron/digest` (hourly), `/internal/cron/prune` (daily) — all with `Authorization: Bearer $CRON_SECRET`.

### 5c. Billing
All three use **Shopify-managed App Pricing** (configure Free/paid tiers in the Partner Dashboard — do NOT add legacy recurring charges). Test with a dev-store test-mode upgrade; confirm the `app_subscriptions/update` webhook flips entitlements and cancellation downgrades. (AlertProof: $9/$19; SKUForge: $12/$19; CheckoutWatch: $19/$49.)

---

## 6. Live-testing smoke drills (per app)

- **SKUForge:** install on dev store → create a default rule + preview (no writes) → scan a small store, compare totals manually (never show "0 duplicate SKUs" without a completed scan) → create a product with Pro automation on → confirm `products/create` hits `/webhooks/products-create`, creates ONE generation job, and a replay is deduped → print one Avery + one thermal PDF at actual size and check geometry/barcode → confirm Free 51-variant store gets a clear 403 upgrade reason.
- **AlertProof:** install → place an order, confirm the normal alert + delivery-status write-back on the order → **reconciliation drill:** deliberately omit a fixture webhook, `POST /internal/cron/reconcile` with the bearer token, confirm the missed event is recovered **exactly once**, dispatched, and written back → simulate a Postmark bounce, confirm Delivery status + (Pro) escalation → check DEAD count is 0.
- **CheckoutWatch:** install → no-code wizard picks a product, generates a checkout test → **store-down drill:** stop the store origin while the independent control endpoint stays healthy, confirm **two** `STORE_UNREACHABLE` runs open an incident and enqueue an alert → confirm AI diagnosis renders (or heuristic fallback) → confirm the public status page sanitizes output and is Pro-gated → verify graceful worker shutdown.

---

## 7. Shopify CLI auth (the one hard boundary)

Live install/OAuth requires a **browser login to Nick's Partner account** — a human (or a browser-capable agent) step; it cannot be scripted headless. Two paths:
- **CLI path:** run `shopify app dev` (or `shopify app config link` then `shopify app deploy`) in the repo; the first run opens a browser to authenticate and link the app, storing a session locally. After that, non-interactive `shopify app deploy` etc. work.
- **Dashboard path (preferred for VPS):** create the app + credentials in the Partner Dashboard by hand, drop them into `.env`, deploy to the VPS subdomain, then install on the dev store from the Dashboard (approve OAuth in browser once).

Verify the CLI is present: `npm i -g @shopify/cli` → `shopify version`. Re-confirm at deploy time that the Partner Dashboard/CLI still accept the pinned Admin API version **`2026-07`** and the RR7 app config (time-sensitive external checks).

---

## 8. Backlog after live testing (per app)

The hardening pass already closed all BLOCKER/MAJOR gaps. Remaining, per each repo's `GAP_REPORT.md` §B:
- **AlertProof:** in-app review-ask moment (growth); recipient webhook-URL validation + per-recipient test send; ops polish (backoff jitter, write-back failures on `/healthz`).
- **CheckoutWatch:** compliance/UX seams (run-now frequency floor, S3 artifact-store fail-fast, error-run stat hygiene); **S3 artifact store** to unlock multi-worker scale; agency multi-store (biggest revenue lever); public "Shopify status — actually tested" marketing page.
- **SKUForge:** label-station UX (variant search/paging + template picker — gates the $19 Premium hook); GS1 UPC/EAN integration; single-instance/ops docs.

---

## 9. Verification the apps are sound (already done this session)

All three: tests green (AlertProof 108, CheckoutWatch 110 + 7 Redis-only in CI, SKUForge 175), production web builds pass unsandboxed, Docker images build (`project-alertproof` 718 MB, `project-skuforge` 1.01 GB, CheckoutWatch web/worker via `docker compose build`). GitHub `main` is the source of truth for each; clone fresh on the VPS rather than copying local working trees.
