# AlertProof going-live handoff

This is the production credential and launch checklist. Never commit a real value to the
repository, `.env`, a Fly config file, an image layer, or a support ticket. Use the hosting
platform secret store and keep an independent recovery record for the encryption key.

## 1. Create and configure the Shopify Partner app

1. Create a public embedded app in the Shopify Partner Dashboard and connect this repository.
2. Set its app URL to the final HTTPS origin and its OAuth callback to
   `https://APP_HOST/auth/callback`.
3. Put the generated values in the deployment secret store as `SHOPIFY_API_KEY` and
   `SHOPIFY_API_SECRET`. Set `SHOPIFY_APP_URL=https://APP_HOST` and keep
   `NODE_ENV=production`, `AUTH_MODE=shopify`, `ALERTPROOF_AUTH_BYPASS=0`, and
   `ALERTPROOF_FORCE_MOCKS=0`.
4. Confirm the scopes in `shopify.app.toml`: `read_orders`, `write_orders`, `read_products`,
   and `read_inventory`. AlertProof only reconciles the recent window. Do not request the
   restricted `read_all_orders` scope unless a future backfill feature truly needs it.
5. Run `shopify app deploy` to register the ordinary and compliance webhook subscriptions.
   Verify `app/uninstalled`, `orders/create`, `orders/paid`, `refunds/create`,
   `inventory_levels/update`, and `order_transactions/create` plus the mandatory
   `customers/data_request`, `customers/redact`, and `shop/redact` topics all target
   `/webhooks/shopify`. Send an invalid-HMAC probe and confirm it is rejected.
6. Install on a development store and complete real OAuth. Confirm the Shop row has the
   store's IANA timezone and the dashboard loads embedded in Admin.

Before submission, re-check that the Partner Dashboard and Shopify CLI still accept the pinned
Admin API `2026-07` and React Router app configuration. Those are external, time-sensitive
handoff checks.

## 2. Provision the database and application secrets

Provision PostgreSQL 16 and set `DATABASE_URL` to its TLS connection string. Create these
secrets with cryptographically random values:

- `CRON_SECRET`: at least 32 random bytes, used as `Authorization: Bearer ...` on internal cron
  routes.
- `ALERTPROOF_ENCRYPTION_KEY`: exactly 32 random bytes encoded as base64. This encrypts merchant
  webhook URLs and BYO-Twilio credentials with AES-256-GCM. Back it up before merchants connect
  credentials; losing or changing it makes stored secrets unreadable. To rotate it, decrypt and
  re-encrypt every stored secret in a controlled migration or have merchants reconnect.

Run `npm run db:deploy` as the release command. Do not point production at SQLite or PGlite.

## 3. Configure Postmark

1. Create a production Postmark server, verify the sending domain, and set
   `POSTMARK_API_TOKEN` and a verified `EMAIL_FROM` address.
2. Add the delivery/bounce webhook `https://APP_HOST/webhooks/email-status`.
3. Configure HTTP Basic Authentication for that webhook and store it as
   `POSTMARK_WEBHOOK_SECRET=username:password`.
4. Send to a controlled inbox, then simulate a bounce and confirm the ProviderEvent and
   Delivery status update. Set conservative Postmark sending caps and an operational alert for
   bounce spikes before opening installs broadly.

## 4. Configure Twilio SMS

For app-funded SMS, set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and
`TWILIO_FROM_NUMBER` together. Configure the Messaging Service/number for the countries being
sold into and complete required A2P registrations. AlertProof supplies
`https://APP_HOST/webhooks/sms-status` as the status callback and validates
`X-Twilio-Signature`.

Merchants may instead enter BYO-Twilio credentials in Settings on Pro. Those values are stored
as one encrypted AES-256-GCM blob. Merchant credentials take precedence over app credentials;
app credentials take precedence over the mock adapter. Test sent, delivered, undelivered, and
failed callbacks without exposing the auth token in logs.

## 5. Deploy on the Hostinger VPS behind Traefik

The checked-in [`docker-compose.production.yml`](../docker-compose.production.yml) is the
production topology: one always-on web container, one private PostgreSQL 16 container, and the
existing external Traefik Docker network. It exposes no host ports; Traefik is the only public
entry point.

1. On the VPS, clone the repository at the reviewed commit and copy
   `.env.production.example` to `.env.production`. Fill it from the VPS secret store, ensure the
   `DATABASE_URL` password matches `POSTGRES_PASSWORD`, and run `chmod 600 .env.production`.
   Back up `ALERTPROOF_ENCRYPTION_KEY` independently before the first merchant connects.
2. Confirm DNS for `ALERTPROOF_HOST` points to the VPS, and that both `TRAEFIK_NETWORK` and
   `TRAEFIK_CERT_RESOLVER` name existing Traefik configuration. Do not put real values in the
   compose file or image layer.
3. Validate rendering before starting anything:
   `docker compose --env-file .env.production -f docker-compose.production.yml config`.
4. Start the release:
   `docker compose --env-file .env.production -f docker-compose.production.yml up -d --build`.
   The web entrypoint runs `prisma migrate deploy` before serving, so migrations occur once per
   container start and remain idempotent.
5. Verify the release before Shopify wiring:
   `curl --fail --show-error https://alertproof.nickbolles.com/healthz`. The JSON must report
   database status, queue depth, DEAD count, and oldest-pending age. Also inspect
   `docker compose --env-file .env.production -f docker-compose.production.yml ps` and logs.
6. Before live merchant data, configure encrypted, off-host PostgreSQL backups with documented
   retention and a tested restore procedure. The backup must be recoverable with the separately
   retained `ALERTPROOF_ENCRYPTION_KEY`; a database backup without that key cannot recover
   merchant-managed encrypted credentials.

The always-on process runs dispatch continuously, reconciliation every 15 minutes, escalation
every minute, digest evaluation hourly, and retention pruning daily. Configure an independent
hosted scheduler as a recovery path using the cron bearer secret:

- every minute: `POST /internal/cron/dispatch` and `/internal/cron/escalate`
- every 15 minutes: `POST /internal/cron/reconcile`
- hourly: `POST /internal/cron/digest`
- daily: `POST /internal/cron/prune`

Keep at least one machine running; sleeping through Shopify webhook traffic is not acceptable.
If another host is used, preserve the same release migration, health check, worker, and cron
semantics.

## 6. Reconciliation and billing checks

After the dev-store install, create an order while the app is reachable, confirm its normal
alert, then intentionally omit a fixture webhook and invoke `/internal/cron/reconcile` with the
cron bearer token. Confirm the missing event is recovered once, dispatched, and written back to
the order. Investigate any DEAD count before launch.

Configure Shopify-managed App Pricing in the Partner Dashboard for Free, Standard ($9), and Pro
($19). Perform a real test-mode upgrade on the dev store. Confirm server-side entitlements,
SKIPPED-with-reason logging, plan downgrade behavior, and cancellation synchronization. Do not
add legacy recurring application charges.

## 7. Submit for Shopify App Review

Complete the listing, support contact, privacy policy, terms, and data-retention disclosures.
Provide review steps for embedded navigation, rule creation, real delivery, delivery status,
reconciliation, billing, and uninstall. Demonstrate substantive handling of all three mandatory
privacy webhooks and confirm shop redaction removes sessions and shop data.

Before clicking submit, run `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test`
against a disposable PostgreSQL test database; run `ALERTPROOF_PERF_TEST=1 npm run perf:sanity`
against that disposable database; inspect `npm audit --omit=dev`; verify no production bypass or
mock route is reachable; and complete one end-to-end order → alert → delivery → callback →
write-back → bounce → escalation exercise.
