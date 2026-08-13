# AlertProof — Launch Plan

**Written:** 2026-08-12 · **Target:** live on a real dev store + submitted to Shopify App Review within 2 days.
**Production host:** `https://alertproof.nickbolles.com` → VPS `72.60.30.172` — ✅ **live with a valid Let's Encrypt cert as of 2026-08-12** (see B0)
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
| **`shopify.app.toml`** | ⚠️ Ready, not deployed | Values all correct (verified 2026-08-13: client id, host, 7+3 webhook topics match `SHOPIFY_TOPICS`, scopes). Awaiting `shopify app config link` + `deploy` — see B1. |
| **VPS environment config** | ⚠️ Partly fixed | Collapsed to a single clean block 2026-08-13; `SCOPES`, `SHOPIFY_API_KEY`, `ALERTPROOF_AUTH_BYPASS` corrected. Still in mock mode pending the real client secret — see B2. |
| **Postmark** | ❌ **BLOCKER** | No real account/verified sender — see B3. |
| **Shopify managed App Pricing** | ❌ **BLOCKER** | Not configured; `SHOPIFY_APP_PRICING_URL` empty — see B4. |
| **Deployed revision** | ⚠️ Stale | VPS working tree checked out to `c2caaf0` on 2026-08-13, but **the container still runs the image built from `c866c47`** — the rebuild was not run. See B5. |
| **App Store listing assets** | ⚠️ Partly done | Privacy policy, terms, and support pages now ship at `/privacy`, `/terms`, `/support` (2026-08-13). Icon + screenshots + listing copy still missing — see B6. |
| **Marketing/landing page** | ✅ Done | `/` is a real landing page (2026-08-13) with plan table sourced from `PLAN_FEATURES` and links to privacy/terms/support. |
| **DB backups** | ✅ Done | Encrypted nightly `pg_dump` + tested restore as of 2026-08-13 — see §5b. On-host only; off-host copy still pending. |
| **Cron recovery path** | ⚠️ Not scheduled | In-process worker is primary (`DISABLE_WORKER=0`, container is always-on). The `/internal/cron/*` recovery path exists but nothing schedules it. |
| **Deploy automation** | ⚠️ Manual | No CD workflow; deploys are manual `git fetch` + `docker compose up -d --build` on the VPS. |

---

## 2. Blockers

Legend: **[H]** = requires a human (browser login, account signup, payment, creative work). **[A]** = an agent can do it.

### B0 — DNS cutover to `alertproof.nickbolles.com` — ✅ **DONE 2026-08-12**

`nickbolles.com` was already owned and hosted on Cloudflare (`rajeev.ns.cloudflare.com` /
`bella.ns.cloudflare.com`). **No domain registration was needed.**

There was never an `alertproof` A record. A **wildcard `*.nickbolles.com` → `134.215.117.4`**
(a residential dynamic broadband IP, `h134-215-117-4.mdtnwi.broadband.dynamic.tds.net`) was
catching every unmatched subdomain, which is why `alertproof`, `skuforge`, and `checkoutwatch`
all appeared to resolve. The fix was therefore **additive**, not an edit:

- **Added:** `alertproof` A → `72.60.30.172`, **DNS only (grey cloud)**, TTL Auto. A specific
  record takes precedence over the wildcard for that one name.
- **Unchanged:** the wildcard, `home` (proxied → `134.215.117.4`), `@` (→ `76.76.21.21`),
  `vps` (proxied → `72.60.30.172`), and every other record. Zone went 29 → 30 records.
- `skuforge.nickbolles.com` and `checkoutwatch.nickbolles.com` still fall through to the
  wildcard. They need the same treatment when those apps are launched.

> ⚠️ **The record must stay DNS-only (grey cloud), not proxied.** Traefik issues certificates
> with the **TLS-ALPN-01** challenge
> (`certificatesresolvers.mytlschallenge.acme.tlschallenge=true`). Cloudflare proxying terminates
> TLS at its edge, so the challenge could never complete. This deviates from the zone's mostly
> proxied convention **on purpose**. If proxying is ever required, Traefik must first be switched
> to the DNS-01 challenge.
>
> Consequence, accepted knowingly: the VPS origin IP is publicly visible for this hostname.
> Cloudflare's dashboard flags this as "origin IP partially exposed."

Completed steps:

1. ✅ Added the Cloudflare record; verified against both the authoritative Cloudflare
   nameservers and `8.8.8.8`.
2. ✅ Set `ALERTPROOF_HOST` and `SHOPIFY_APP_URL` in `/etc/vps-apps/alertproof.env`
   (timestamped backup taken first).
3. ✅ Redeployed; Traefik router rule is now ``Host(`alertproof.nickbolles.com`)``.
4. ✅ Let's Encrypt certificate issued (`CN=alertproof.nickbolles.com`, issuer `YR2`,
   valid to 2026-11-10). `https://alertproof.nickbolles.com/healthz` returns
   `{"ok":true,"database":{"ok":true},...}`.
5. ✅ Security posture re-probed on the new host: invalid-HMAC webhook → 401, `/dev/mock` → 404,
   `/app` unauthenticated → 410, HTTP → HTTPS 301.

`https://alertproof.srv1073822.hstgr.cloud` now returns 404 — Traefik no longer has a router for
it. That is expected; nothing depended on it.

> ⚠️ **`/etc/vps-apps/alertproof.env` contains every key twice.** Lines 1–42 are a copy of
> `.env.production.example`; lines 44–61 are an appended override block. Docker Compose takes the
> **last** occurrence, so the override block is what is live. Only the effective lines (47, 58)
> were edited. **Rewrite this file as a single clean block during the B2 credential swap** — as it
> stands, editing the "obvious" first occurrence of any key silently does nothing.

> ⚠️ **Deploy with an explicit project name:**
> `docker compose -p alertproof --env-file .env.production -f docker-compose.production.yml up -d`.
> Without `-p alertproof`, Compose derives the project from the directory name
> (`project-alertproof`) and stands up a **parallel stack with an empty database** instead of
> updating the running one. This happened once during the cutover and was rolled back; the
> original `alertproof_alertproof-postgres` volume was never touched. An orphaned empty volume
> `project-alertproof_alertproof-postgres` remains and can be removed at leisure.

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

### B5 — VPS is running a stale image **[A]** · 15 min

**Status 2026-08-13:** the VPS working tree is now checked out at `c2caaf0`, but the rebuild was
**not** run, so the container still serves the image built from `c866c47`. The one remaining step is:

```bash
cd /opt/vps-apps/project-alertproof && \
  docker compose -p alertproof --env-file .env.production \
  -f docker-compose.production.yml up -d --build
```

This is also what applies the corrected `SCOPES` and `SHOPIFY_API_KEY` — the running container
still holds the old values in its environment.

Originally: VPS at `c866c47`; `main` at `63679b4`. The VPS is missing:

- `acc1742` — **fix: keep billing navigation embedded** (a real user-facing bug: billing nav
  breaking out of the embedded admin frame). App reviewers will hit this.
- `63679b4` — test clock-drift fix.

Redeploy is required regardless, since B2's env changes need a container restart.

### B7 — Protected customer data access not approved **[H]** · 20–30 min — ⛔ **NEW, blocks everything**

Discovered 2026-08-13 by actually running `shopify app deploy`. It failed:

```
Version couldn't be created.
  • This app is not approved to subscribe to webhook topics containing
    protected customer data.   (×4)
```

All four order topics — `orders/create`, `orders/paid`, `order_transactions/create`,
`refunds/create` — carry protected customer data, so Shopify refuses to create the app version
at all. **Nothing partial gets registered: the deploy is all-or-nothing, so there are still zero
webhook subscriptions on Shopify's side.**

This is not a code or config problem and cannot be worked around by trimming the topic list —
those four topics *are* the product. It is a one-time approval request in the Partner Dashboard:

> **Apps → AlertProof → API access → Protected customer data access → Request access**

Level 1 (protected customer data) is required. Level 2 (name, email, phone, address) is **not** —
the app never reads customer PII fields, only order-level data. Requesting only Level 1 keeps the
review surface smaller.

The form asks how data is used, retained, encrypted, and who can access it. The answers are all
already documented on the new `/privacy` page — reuse them:

| Form question | Answer, per the code |
|---|---|
| Purpose | Send staff alerts on order events; record delivery outcome |
| Data retained | Order id/name/value + financial status; **no customer PII** |
| Retention period | Per plan: 7d Free / 90d Standard / unlimited Pro; raw payloads purged at 30d |
| Encryption at rest | AES-256-GCM for merchant-supplied secrets; TLS in transit |
| Staff access | Restricted; data partitioned per shop |

For a dev app this is typically approved immediately on submission. **This is now the top of the
critical path** — tasks 8, 9, and 13 are all blocked behind it.

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
| ~~3b~~ | ~~Cloudflare: add `alertproof` A record → `72.60.30.172`, grey cloud~~ | A | — | ✅ done | — |
| ~~3c~~ | ~~Set `ALERTPROOF_HOST` + `SHOPIFY_APP_URL`; redeploy; confirm cert + `/healthz`~~ | A | — | ✅ done | — |
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

**Revised 2026-08-13.** Tasks 3b, 3c, 4, 5 and 6 are done. The path is now:

`B7 (protected customer data approval) → 8 (webhook deploy) → 9 (OAuth install) → 13 (order drill) → 20 (screenshots) → 22 (submit)`

B7 is a new, hard blocker discovered by running the deploy for real. Everything downstream of it
is blocked, and it is a Partner Dashboard approval only the app owner can request. Of the rest,
only tasks 9, 20 and 22 need a human.

---

## 4. Human gates (cannot be automated)

0. ~~**Cloudflare login**~~ — ✅ done 2026-08-12, record added. Still needed later for Postmark's
   DKIM + Return-Path records (B3), and for `skuforge`/`checkoutwatch` when those launch.
1. **Shopify Partner browser login** for `shopify app config link` (task 4) and approving OAuth on
   the dev store (task 9).
2. **Real Client Secret** — must be pasted into the VPS env by a human; never into chat or git.
3. **Postmark signup + DNS records** on the sending domain (task 2).
4. **Managed App Pricing configuration** in the Partner Dashboard (task 11).
5. **Creative + legal collateral**: icon, screenshots, privacy policy, support contact (Lane C).
6. **Encryption key backup** (task 1) — a decision only the owner should make about where it lives.

---

## 4b. Progress log — 2026-08-13 (agent pass)

Done in this pass, without human intervention:

- **`shopify.app.toml` verified end to end.** `client_id`, `application_url`, `redirect_urls`,
  `automatically_update_urls_on_dev = false`, scopes, and both webhook subscription blocks are
  correct. The 7 regular + 3 compliance topics match `SHOPIFY_TOPICS` in
  `app/lib/ingest/topics.ts` exactly. **No file change was needed.**
  - ⚠️ The host is `alertproof.nickbolles.com`, *not* `alertproof.srv1073822.hstgr.cloud`. The
    hstgr hostname has had no Traefik router since the B0 cutover and returns 404; only the
    nickbolles.com host is routed and holds a valid certificate. Re-probed 2026-08-13.
- **Public pages shipped** (`/`, `/privacy`, `/terms`, `/support`) — closes launch task 19 and the
  privacy-policy/support-contact halves of B6. Contact address is the new `SUPPORT_EMAIL` env var
  (default `support@alertproof.nickbolles.com`); a mailbox must actually exist there before
  submission. Legal copy is drafted from the real schema and retention code but has **not** had
  legal review.
- **§5 drift cleaned:** `fly.toml` marked unused with `auto_stop_machines = "off"`; the phantom
  `extensions/*` workspaces entry removed from `package.json`; `DEPLOYMENT_HANDOFF.md` now warns
  that a local `npm test` skips 45 integration tests.
- **VPS env collapsed to a single clean block** (`/etc/vps-apps/alertproof.env`, backup taken).
  The double-block trap described in B0 is gone. `SCOPES` corrected to all four scopes,
  `SHOPIFY_API_KEY` set to the real client id, `ALERTPROOF_AUTH_BYPASS` set to `0`.
- **`go-live.sh` added on the VPS** — takes the client secret, flips `AUTH_MODE=shopify` and
  `ALERTPROOF_FORCE_MOCKS=0`, redeploys, and verifies. One command once B2's secret exists.
- **Encrypted nightly Postgres backups** with a tested restore (see §5b).

Deliberately *not* done, and why:

- **`AUTH_MODE` and `ALERTPROOF_FORCE_MOCKS` left at `mock`/`1`.** Flipping them without the real
  `SHOPIFY_API_SECRET` would take the app from a working demo to one that fails every Shopify API
  call, with no compensating benefit — the secret is a hard human gate either way.
- ~~**`shopify app config link` / `deploy` not run.**~~ Both were run on 2026-08-13:
  - `config link` **succeeded** — the CLI already held a valid Partner session, so no browser
    login was needed after all. It revealed that the **Partner Dashboard app was still configured
    with `https://alertproof.srv1073822.hstgr.cloud`**, and overwrote the local toml with it. The
    local toml was restored to `alertproof.nickbolles.com`; since config is included on deploy, a
    successful deploy will correct the Dashboard at the source. **Until then the Dashboard still
    points at a host that 404s, so a real OAuth install would fail regardless of credentials.**
  - `deploy` **failed** on protected-customer-data approval — see the new **B7**, which is now the
    top of the critical path.
  - The CLI also removed `include_config_on_deploy` from the toml: the field is no longer
    supported because config is now *always* included on deploy. Behaviour is unchanged.

## 5. Known inconsistencies to clean up

These are documentation/config drift, not functional problems, but they will confuse the next
person (or agent) touching this:

- ~~**Hostname drift.**~~ **Resolved 2026-08-12:** `alertproof.nickbolles.com` is the decided
  production host, which is what `docs/GOING_LIVE.md`, `.env.production.example`, and
  `DEPLOYMENT_HANDOFF.md` already say. The remaining work is the DNS + env cutover in **B0**.
- ~~**`fly.toml` is dead weight and misleading.**~~ ✅ Fixed 2026-08-13: marked unused in a header
  comment and `auto_stop_machines` set to `"off"`.
- ~~**`DEPLOYMENT_HANDOFF.md` claims "108 tests pass"**~~ ✅ Fixed 2026-08-13: §9 now carries an
  explicit warning that a local `npm test` reports 63–64 passed / 45 skipped and still exits 0.
- ~~**`package.json` declares `workspaces: ["extensions/*"]`**~~ ✅ Fixed 2026-08-13: removed.
- **VPS repo is still on a detached HEAD**, now at `c2caaf0`. `/usr/local/bin/alertproof-go-live.sh`
  (versioned at `scripts/vps/alertproof-go-live.sh`) covers the credential flip and redeploy, but
  there is still no plain redeploy script or CD workflow.

## 5b. Backups — ✅ done 2026-08-13

Encrypted nightly logical backups are live, and a restore has been tested end to end.

- `/usr/local/bin/alertproof-backup.sh` (versioned at `scripts/vps/alertproof-backup.sh`):
  `pg_dump` → gzip → `openssl enc -aes-256-cbc -pbkdf2 -iter 200000`, written to
  `/var/backups/alertproof/`, 14 daily copies retained. `set -euo pipefail` plus a
  `.partial` → final rename means a failed dump can never be promoted to a real backup name.
- Scheduled by `/etc/cron.d/alertproof-backup` at 03:17 UTC daily; output goes to syslog
  (`journalctl -t alertproof-backup`).
- **Restore tested 2026-08-13:** the encrypted backup was decrypted and restored into a scratch
  database, producing all 14 tables and 3 `_prisma_migrations` rows, then the scratch database was
  dropped. The restore command is documented in the script header.

> ⚠️ **Two keys must be backed up off-host, or the data is unrecoverable:**
> `/etc/vps-apps/alertproof-backup.key` (without it every backup file is unreadable) and
> `ALERTPROOF_ENCRYPTION_KEY` from `/etc/vps-apps/alertproof.env` (without it every stored Slack,
> Discord, and Twilio secret is unreadable). Both are currently on the VPS **only**.

> ⚠️ Backups are **on-host only**. A VPS loss loses both the database and its backups. Moving them
> off-host needs storage credentials, which is a human gate — add `rclone`/S3 and a second cron
> line once a bucket exists.

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
