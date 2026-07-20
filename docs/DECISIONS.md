# Phase 0 decisions

## Shopify template and API version

- Shopify still recommends the React Router template for most new apps. The scaffold follows
  its root-level React Router 7 layout and `@shopify/shopify-app-react-router` v1 package line.
- The Admin API and app-managed webhook serialization are pinned to the current stable
  `2026-07` release. The planned `orders/create`, `orders/paid`, `refunds/create`,
  `inventory_levels/update`, and `order_transactions/create` topics remain available.
- The local Shopify CLI could not be used because this build host has no Partner login or Node
  runtime. Phase 0 was scaffolded from the current official template manifest and conventions;
  live OAuth remains credential-gated exactly as planned.

## Billing drift

Shopify App Pricing is now Shopify's recommended default for public apps; the Billing API is
legacy for new apps. The Phase 0 `BillingService` port remains deliberately implementation-neutral
and its Shopify adapter is a typed stub. Phase 6 should implement Shopify App Pricing/Partner API
subscription confirmation behind that port instead of creating legacy recurring charges.

## Postmark callback authentication

Postmark's current webhook overview says it does not provide HMAC signatures and recommends
HTTP Basic Authentication plus optional source-IP allowlisting. `POSTMARK_WEBHOOK_SECRET` is kept
as the mock callback bearer secret in Phase 0. Phase 3 should interpret real credentials as Basic
Auth username/password (or configured custom header) without changing the port.

## Development database

Production and committed development configuration remain PostgreSQL 16. Docker Compose is the
supported local path. This host has Docker CLI installed but cannot access the Docker daemon, so
Phase 0 verification used a temporary PGlite PostgreSQL wire-protocol server to apply the real
migration, run the idempotent seed, and execute the integration test. PGlite is not an application
dependency or supported runtime database; CI and normal development use PostgreSQL 16. No SQLite
production/schema deviation was introduced.
