# AlertProof — Launch Plan

**Written:** 2026-08-12 · **Target:** live on a real dev store + submitted to Shopify App Review within 2 days.
**Production host (decided 2026-08-12):** `https://alertproof.nickbolles.com` → VPS `72.60.30.172`
**Currently serving:** `https://alertproof.srv1073822.hstgr.cloud` (Hostinger VPS, Traefik + Let's Encrypt) — to be cut over, see B0
**Shopify dev app:** Client ID `926e44e19dcebedd5e9978ab4c99e3c7`, installed on `alertproof-lab` dev store
**Repo HEAD audited:** `63679b4` (origin/main)

---

## 0. Bottom line

**The code is done. The infrastructure is done. What is missing is configuration, credentials, and App Store listing collateral.**

Every finding below is a config/credential/content gap, not an engineering gap. There are zero
`TODO`/`FIXME` markers in `app/`, all 8 build phases are implemented, both `GAP_REPORT.md`
BLOCKERs and all six MAJORs are fixed in code (verified line-by-line during this audit),
`typecheck`/`lint`/`build` pass, and CI is green on `main`.

### What "launch" can realistically mean in 1–2 days

| Goal | Achievable in 1–2 days? |
|---|---|
| App fully live and working against the real `alertproof-lab` dev store, real OAuth, real Shopify webhooks, real Postmark email + delivery proof | **Yes** — this is Day 1. |
| Billing tested end-to-end with a real test-mode charge | **Yes** — Day 2. |
| Listing complete and **submitted** to Shopify App Review | **Yes** — end of Day 2, *if* the listing collateral (icon, screenshots, privacy policy) gets made. |
| **Publicly listed on the Shopify App Store** | **No — not in your control.** Shopify App Review is a queue; first response typically takes days to a few weeks, and first submissions commonly come back with change requests. Plan for submission on Day 2 and iteration after. |

Treat "launch in 1–2 days" as **"live, proven, and submitted."** That is fully achievable.

---

## 1. Component status

| Component | Status | Notes |
|---|---|---|
| **Application code** | ✅ Complete | 76 source files, 0 TODO/FIXME. All phases 0–8 implemented. |
| **Gap-report BLOCKERs** | ✅ Fixed | Order-ID GID normalization + real billing plan sync (commit `cb7ac47`). |
| **Gap-report MAJORs 1–6** | ✅ Fixed | Trial-caps-Pro, mock delivery lifecycle, escalation SQL filter, refunded paid-statuses, Postmark SpamComplaint→bounced, per-shop requeue — all verified in code. |
| **Typecheck / Lint / Build** | ✅ Pass | Verified locally on `63679b4`. |
| **Tests** | ✅ Pass | 108 tests. Locally 63 pass / 45 skip (integration needs `TEST_DATABASE_URL`); **CI runs all 108 against real Postgres 16 and is green on `main`**. |
| **CI (GitHub Actions)** | ✅ Green | `.github/workflows/ci.yml` — lint, typecheck, build, migrate, seed, test. |
| **Prisma migrations** | ✅ Consistent | 3 migrations; schema fields covered; CI applies `migrate deploy` + schema test each run. |
| **Dockerfile** | ✅ Working | Multi-stage Node 20 alpine; image built and running on VPS. |
| **VPS deployment** | ✅ Running | `alertproof-web-1` healthy 12 days + private `alertproof-postgres-1` healthy. |
| **Reverse proxy / TLS** | ✅ Done | Traefik router `alertproof` → `Host(alertproof.srv1073822.hstgr.cloud)`, `websecure`, cert resolver `mytlschallenge`, LE `acme.json` present. No host ports exposed; Traefik is the only entry point. |
| **Health checks** | ✅ Live | `GET /healthz` → `{"ok":true,"database":{"ok":true},"queue":{"depth":0,"dead":0,...}}` over public HTTPS. `/livez` used for container liveness. |
| **Production compose** | ✅ Present | `docker-compose.production.yml`, env symlinked from `/etc/vps-apps/alertproof.env` (chmod 600, outside git). |
| **Security posture (live-probed)** | ✅ Correct | Invalid-HMAC webhook → **401**. `/dev/mock` → **404**. `/app` unauthenticated → **410**. Auth bypass is hard-gated to `NODE_ENV=development\|test` **and** literal `dev-key`/`dev-secret` — it cannot arm in production. |
| **Admin API version** | ✅ Valid | `2026-07` is the latest stable `ApiVersion` in the installed SDK (`July26`). |
| **Billing plan sync** | ✅ Implemented | `app_subscriptions/update` topic handler + `currentAppInstallation.activeSubscriptions` reconcile. |
| **GDPR webhooks** | ✅ Implemented | All three mandatory topics handled substantively. |
| **`shopify.app.toml`** | ❌ **BLOCKER** | Still the dev placeholder — see B1. |
| **VPS environment config** | ❌ **BLOCKER** | Running in **mock/demo mode** with placeholder credentials — see B2. |
| **Postmark** | ❌ **BLOCKER** | No real account/verified sender — see B3. |
| **Shopify managed App Pricing** | ❌ **BLOCKER** | Not configured; `SHOPIFY_APP_PRICING_URL` empty — see B4. |
| **Deployed revision** | ⚠️ Stale | VPS is at `c866c47`; `main` is `63679b4` (2 commits ahead) — see B5. |
| **App Store listing assets** | ❌ **BLOCKER** | No icon, screenshots, privacy policy, or support contact — see B6. |
| **Marketing/landing page** | ⚠️ Stub | `/` still renders "The Phase 0 application shell is ready." |
| **DB backups** | ❌ Missing | No backup/restore for the `alertproof-postgres` volume. Required before real merchant data. |
| **Cron recovery path** | ⚠️ Not scheduled | In-process worker is primary (`DISABLE_WORKER=0`, container is always-on). The `/internal/cron/*` recovery path exists but nothing schedules it. |
| **Deploy automation** | ⚠️ Manual | No CD workflow; deploys are manual `git fetch` + `docker compose up -d --build` on the VPS. |

---

## 2. Blockers

Legend: **[H]** = requires a human (browser login, account signup, payment, creative work). **[A]** = an agent can do it.

### B0 — DNS cutover to `alertproof.nickbolles.com` **[H for Cloudflare, A for the rest]** · 30–45 min

`nickbolles.com` is already owned and hosted on Cloudflare (`rajeev.ns.cloudflare.com` /
`bella.ns.cloudflare.com`). **No domain registration is needed.** But all three app subdomains
currently point at the wrong machine:

| Hostname | Resolves to | Should be |
|---|---|---|
| `alertproof.nickbolles.com` | `134.215.117.4` | `72.60.30.172` |
| `skuforge.nickbolles.com` | `134.215.117.4` | `72.60.30.172` |
| `checkoutwatch.nickbolles.com` | `134.215.117.4` | `72.60.30.172` |

`134.215.117.4` reverse-resolves to `h134-215-117-4.mdtnwi.broadband.dynamic.tds.net` — a
residential dynamic broadband IP, almost certainly a stale record from an earlier setup.

> ⚠️ **The A records must be DNS-only (grey cloud), not proxied (orange cloud).** Traefik issues
> certificates with the **TLS-ALPN-01** challenge
> (`certificatesresolvers.mytlschallenge.acme.tlschallenge=true`). Cloudflare proxying terminates
> TLS at its edge, so the challenge can never complete and Traefik will never get a certificate.
> The apex `nickbolles.com` is proxied today; that is fine and unrelated.

Cutover order matters — **do this before B1**, because the Shopify App URL must be registered
against the final hostname. Changing it after submission means re-doing OAuth config,
re-registering webhooks, and possibly a re-review.

1. **[H]** Fix the `alertproof` A record in Cloudflare → `72.60.30.172`, grey cloud.
2. **[A]** Set `ALERTPROOF_HOST=alertproof.nickbolles.com` and
   `SHOPIFY_APP_URL=https://alertproof.nickbolles.com` in `/etc/vps-apps/alertproof.env`.
3. **[A]** Redeploy so the Traefik router rule picks up the new host.
4. **[A]** Watch Traefik logs until the certificate is issued, then verify
   `curl --fail https://alertproof.nickbolles.com/healthz`.

Keeping the old `srv1073822.hstgr.cloud` router alongside the new one during cutover is harmless
and gives a rollback path; drop it once the new cert is confirmed.

### B1 — `shopify.app.toml` is still the dev placeholder **[H then A]** · 30–45 min

`shopify.app.toml` currently reads:

```toml
client_id = "dev-key"
application_url = "http://localhost:3000"
redirect_urls = ["http://localhost:3000/auth/callback"]
```

**Partially resolved 2026-08-12:** `client_id`, `application_url`, and `redirect_urls` are now set
to the real app and `https://alertproof.nickbolles.com`, and
`automatically_update_urls_on_dev` is `false`. What remains is the CLI link + deploy below.

It must point at the real app (`926e44e19dcebedd5e9978ab4c99e3c7`) and the live HTTPS origin.
Until `shopify app deploy` runs against the real app, **no webhook subscriptions are registered
with Shopify** — orders would never reach the app, which is the entire product.

There is no `.shopify/` directory in the repo, so the Shopify CLI has **never been authenticated
on this machine**. `shopify app config link` opens a browser for Partner login — that is the
human gate. Everything after it is scriptable.

Also set `automatically_update_urls_on_dev = false` before deploying, so a later `shopify app dev`
does not silently rewrite the production `application_url` back to a tunnel.

The webhook topic list and scopes in the toml are already correct and match the dev app.

### B2 — VPS is running in mock/demo mode with placeholder credentials **[H for values, A to apply]** · 30 min

`/etc/vps-apps/alertproof.env` currently has (values verified by name/length only, never printed):

| Var | Current | Required |
|---|---|---|
| `AUTH_MODE` | `mock` | `shopify` |
| `ALERTPROOF_AUTH_BYPASS` | `1` | `0` |
| `ALERTPROOF_FORCE_MOCKS` | `1` | `0` |
| `SHOPIFY_API_KEY` | placeholder (`local-mo…`, 10 chars) | `926e44e19dcebedd5e9978ab4c99e3c7` |
| `SHOPIFY_API_SECRET` | placeholder (10 chars) | real client secret |
| `SCOPES` | `read_products` ← **wrong** | `read_orders,write_orders,read_products,read_inventory` |
| `POSTMARK_API_TOKEN` | placeholder (9 chars) | real server token |
| `EMAIL_FROM` | `alerts@example.com` | verified sending address |
| `SHOPIFY_APP_PRICING_URL` | empty | managed pricing URL (B4) |

Already correct and should **not** be regenerated: `SHOPIFY_APP_URL`, `ALERTPROOF_HOST`,
`NODE_ENV=production`, `DISABLE_WORKER=0`, `CRON_SECRET` (64 chars), `ALERTPROOF_ENCRYPTION_KEY`
(44 chars = 32 bytes base64), `TRAEFIK_*`, Postgres vars.

> ⚠️ **Back up `ALERTPROOF_ENCRYPTION_KEY` to an independent location before the first merchant
> saves a Slack/Discord webhook URL or BYO-Twilio credential.** Losing it makes every stored
> secret permanently unreadable. This is the single highest-consequence, lowest-effort item on
> this page. Do it first.

The app is currently *safe* despite `ALERTPROOF_AUTH_BYPASS=1` — the bypass requires
`NODE_ENV=development|test`, so it is inert. But leaving it set is a trap; set it to `0`.

### B3 — Postmark account, verified sending domain, and status webhook **[H]** · 45–90 min (+ DNS propagation)

The delivery log is the product's entire differentiator; it is driven by Postmark delivery/bounce
callbacks. Required:

1. Create a Postmark server, verify the sending domain (DKIM + Return-Path DNS records — this is
   the step that can take hours to propagate, so **start it first thing on Day 1**).
2. `POSTMARK_API_TOKEN` = server token; `EMAIL_FROM` = a verified address on that domain.
3. Add webhook `https://alertproof.srv1073822.hstgr.cloud/webhooks/email-status` with HTTP Basic
   auth; store as `POSTMARK_WEBHOOK_SECRET=username:password`.
4. Enable Delivery, Bounce, and SpamComplaint events (the code maps SpamComplaint → `bounced`).
5. Set conservative sending caps before opening installs.

Twilio SMS is **optional** — it is a Pro feature and can ship dark. Leave all three `TWILIO_*`
vars empty and SMS falls back to the mock adapter; merchants on Pro can supply BYO credentials.
A2P 10DLC registration takes weeks, so do **not** put app-funded SMS on the launch path.

### B4 — Shopify managed App Pricing not configured **[H]** · 20 min

Configure Free / Standard $9 / Pro $19 as **managed pricing** in the Partner Dashboard (not legacy
recurring charges — the code deliberately creates none). Copy the resulting pricing page URL into
`SHOPIFY_APP_PRICING_URL`.

Until this is set, `ShopifyBillingService.requestSubscription` throws `NotConfiguredError` and the
in-app upgrade button is dead.

### B5 — VPS is 2 commits behind `main` **[A]** · 15 min

VPS is at `c866c47`; `main` is `63679b4`. The VPS is missing:

- `acc1742` — **fix: keep billing navigation embedded** (a real user-facing bug: billing nav
  breaking out of the embedded admin frame). App reviewers will hit this.
- `63679b4` — test clock-drift fix.

Redeploy is required regardless, since B2's env changes need a container restart.

### B6 — App Store listing collateral does not exist **[H]** · 3–5 hours

Nothing in the repo supports a listing. Shopify requires all of these before submission:

- **App icon** (1200×1200 PNG) — none exists.
- **Screenshots** (desktop, min 3, 1600×900) — none exist. Capture them from the live embedded
  app *after* B1–B3 land, so they show real orders and a real delivery log.
- **Privacy policy URL** — does not exist. The app stores staff emails/phone numbers and order
  metadata; a real policy is mandatory.
- **Support contact email** and support/FAQ URL.
- **Listing copy**: tagline, description, feature bullets, demo store URL.
- **Reviewer instructions** covering: embedded nav, rule creation, real delivery, delivery status
  on the order, reconciliation, billing, uninstall, and the three privacy webhooks.

Also replace the `/` route — it currently renders "The Phase 0 application shell is ready.", which
is the first thing a reviewer sees. It should be a real landing page linking to privacy/terms/support.

**This is the long pole of the whole launch.** Start it in parallel on Day 1, not on Day 2.

---

## 3. Execution plan

Three lanes run in parallel. Lane A is the critical path; Lane C is the long pole.

### Day 1

| # | Task | Lane | Who | Est. | Depends on |
|---|---|---|---|---|---|
| 1 | **Back up `ALERTPROOF_ENCRYPTION_KEY`** off-host to a password manager | A | H | 5 min | — |
| 2 | Start Postmark signup + **domain verification DNS records** (slowest external dependency — kick off first) | B | H | 30 min + propagation | — |
| 3 | Start icon + screenshots-plan + privacy policy draft | C | H | 3–5 h | — |
| 3b | **Cloudflare: point `alertproof` A record at `72.60.30.172`, grey cloud (DNS-only)** | A | H | 10 min | — |
| 3c | Set `ALERTPROOF_HOST` + `SHOPIFY_APP_URL` to the new host; redeploy; confirm Traefik issues the cert and `https://alertproof.nickbolles.com/healthz` returns 200 | A | A | 30 min | 3b |
| 4 | `shopify app config link` → select app `926e44e…`; confirm the toml's `application_url`/`redirect_urls` match the new host | A | H (browser login), then A | 30 min | 3c |
| 5 | Copy real Client ID/secret into `/etc/vps-apps/alertproof.env`; flip `AUTH_MODE=shopify`, `ALERTPROOF_AUTH_BYPASS=0`, `ALERTPROOF_FORCE_MOCKS=0`; **fix `SCOPES`** | A | H (secret) + A | 20 min | 4 |
| 6 | `git fetch && git checkout 63679b4` on VPS; `docker compose --env-file .env.production -f docker-compose.production.yml up -d --build` | A | A | 15 min | 5 |
| 7 | Verify `/healthz` 200, DB ok, DEAD 0; invalid-HMAC probe still 401 | A | A | 10 min | 6 |
| 8 | `shopify app deploy` → register 7 order/app topics + 3 GDPR topics; confirm in Partner Dashboard | A | A | 15 min | 4, 6 |
| 9 | **Install on `alertproof-lab` via real OAuth**; confirm Shop row gets the store IANA timezone and dashboard renders embedded | A | H (approve OAuth) | 20 min | 8 |
| 10 | Postmark token + verified `EMAIL_FROM` + status webhook into env; redeploy | B | H + A | 30 min | 2, 6 |
| 11 | Configure managed App Pricing (Free/$9/$19); set `SHOPIFY_APP_PRICING_URL`; redeploy | A | H | 20 min | — |
| 12 | Configure encrypted off-host Postgres backups + **test a restore** | A | A | 45 min | 6 |

**End of Day 1 target:** real OAuth install working, real Shopify webhooks arriving, real email
sending with delivery confirmation.

### Day 2

| # | Task | Lane | Who | Est. | Depends on |
|---|---|---|---|---|---|
| 13 | **Smoke drill 1 — happy path:** place a real order on `alertproof-lab` → alert delivered → delivery status written back to the order | A | H+A | 30 min | Day 1 |
| 14 | **Smoke drill 2 — reconciliation:** omit a webhook, `POST /internal/cron/reconcile` with the bearer token, confirm the miss is recovered **exactly once** and not double-alerted | A | A | 30 min | 13 |
| 15 | **Smoke drill 3 — bounce:** send to a Postmark bounce address, confirm `ProviderEvent` + Delivery → `BOUNCED`, then Pro escalation fires | A | A | 30 min | 13 |
| 16 | **Smoke drill 4 — billing:** test-mode upgrade to Pro, confirm `app_subscriptions/update` flips `Shop.plan`; then cancel and confirm downgrade | A | H | 30 min | 11, 13 |
| 17 | **Smoke drill 5 — GDPR + uninstall:** fire all three privacy webhooks, confirm substantive handling; uninstall and confirm shop redaction removes sessions | A | A | 30 min | 13 |
| 18 | Confirm DEAD count is 0 and no write-back failures across all drills | A | A | 15 min | 13–17 |
| 19 | Replace `/` with a real landing page (privacy/terms/support links) | C | A | 45 min | 3 |
| 20 | Capture listing screenshots from the live embedded app | C | H | 45 min | 13 |
| 21 | Publish privacy policy + support page at stable URLs | C | H | 45 min | 3 |
| 22 | Fill the App Store listing, write reviewer instructions, **submit** | C | H | 90 min | 19–21 |

**Pre-submit gate (run before task 22):** `npm run typecheck && npm run lint && npm run build && npm test`
against a disposable Postgres, `ALERTPROOF_PERF_TEST=1 npm run perf:sanity`, and `npm audit --omit=dev`.

### What parallelizes

- **Lane B (Postmark)** and **Lane C (listing)** are fully independent of Lane A. Start both on
  Day 1 morning.
- Postmark DNS propagation (task 2) runs in the background for hours — that is why it goes first.
- Tasks 11 (pricing) and 12 (backups) do not block the OAuth install and can slot anywhere.
- Smoke drills 14–17 can run concurrently once drill 13 proves the pipeline.

### Critical path

`3b (DNS) → 3c (host cutover) → 4 (link app) → 5 (env) → 6 (redeploy) → 8 (webhook deploy) → 9 (OAuth install) → 13 (order drill) → 20 (screenshots) → 22 (submit)`

Everything on it except tasks 3b, 4, 9, 20 and 22 is agent-executable.

---

## 4. Human gates (cannot be automated)

0. **Cloudflare login** to fix the `alertproof` A record (task 3b). No domain registration is
   needed — `nickbolles.com` is already owned. Must be grey-cloud/DNS-only, see B0.
1. **Shopify Partner browser login** for `shopify app config link` (task 4) and approving OAuth on
   the dev store (task 9).
2. **Real Client Secret** — must be pasted into the VPS env by a human; never into chat or git.
3. **Postmark signup + DNS records** on the sending domain (task 2).
4. **Managed App Pricing configuration** in the Partner Dashboard (task 11).
5. **Creative + legal collateral**: icon, screenshots, privacy policy, support contact (Lane C).
6. **Encryption key backup** (task 1) — a decision only the owner should make about where it lives.

---

## 5. Known inconsistencies to clean up

These are documentation/config drift, not functional problems, but they will confuse the next
person (or agent) touching this:

- ~~**Hostname drift.**~~ **Resolved 2026-08-12:** `alertproof.nickbolles.com` is the decided
  production host, which is what `docs/GOING_LIVE.md`, `.env.production.example`, and
  `DEPLOYMENT_HANDOFF.md` already say. The remaining work is the DNS + env cutover in **B0**.
- **`fly.toml` is dead weight and misleading.** It has `auto_stop_machines = "stop"`, which
  directly contradicts the "must stay awake or drop webhooks" requirement. Deployment is on the
  VPS. Either delete `fly.toml` or set `auto_stop_machines = "off"` and mark it unused.
- **`DEPLOYMENT_HANDOFF.md` claims "108 tests pass"** — accurate in CI, but a local `npm test`
  skips 45 integration tests unless `TEST_DATABASE_URL` is set. Worth a note so a local green run
  is not mistaken for full coverage.
- **`package.json` declares `workspaces: ["extensions/*"]`** but no `extensions/` directory exists.
  Harmless; remove for tidiness.
- **VPS repo is on a detached HEAD** with no deploy script. Consider a two-line deploy script or a
  CD workflow so redeploys are reproducible.

---

## 6. Post-submission backlog

Not launch blockers. Ordered by value-for-effort, carried forward from `GAP_REPORT.md` §B:

1. **In-app review-ask moment** (S) — reviews are App Store ranking currency; trigger after N
   delivered alerts or the first reconciliation-caught miss. Cheapest high-leverage growth item.
2. **Recipient webhook-URL validation + per-recipient test send** (M) — a typo'd Slack URL
   currently surfaces only as a failed delivery during a real order.
3. **Write-back settings UI** (S) — `settings.writeback`/`writebackMetafield`/`writebackNote` are
   honored by the backend but no route ever writes them (`GAP_REPORT` MINOR 4, still open).
4. **Ops polish** (S) — ±20% backoff jitter (MINOR 5c, still open); surface write-back failure
   count and oldest stuck-`SENDING` age on `/healthz`.
5. **Delivery-log UX** (S) — pagination drops active filters; pruned "skeleton" alerts need a
   "details expired" label (MINOR 3).
6. **Reinstall re-enables rules or shows a banner** (S) — a reinstalling merchant currently gets a
   silently inert app (MINOR 2).
7. **Retention vs. DEAD requeue** (S) — payload nulling at 30d breaks requeue of DEAD events that
   live until 90d (MINOR 6).
8. **Schedule `/internal/cron/*` as a recovery path** — the in-process worker is primary, but an
   external scheduler is cheap insurance if the container wedges.

---

## 7. Standing risk

Correctness is proven against **mocks**. The production-shape contract-test suite
(`tests/unit/production-adapter-contract.test.ts`) exists precisely because the one class of bug
this build kept producing was "mock and real adapter disagree about data shape" — that is what
BLOCKER 1 was. **Expect the first real-store install to surface small shape mismatches.** Budget
time for it on Day 1, and when one appears, add a contract test rather than a point fix.
