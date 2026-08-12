# Progress

## 2026-07-24 — VPS hosting baseline

- Hosted release verified at `c866c4720d5388d76be3650988ef9d442ac9259e`.
- PostgreSQL and web are healthy; Traefik routing and public HTTPS health checks are verified.
- The health response reports queue depth `0` and dead jobs `0`.
- Brand recommendation is to retain **AlertProof**; do not purchase or reconfigure domains until registrar availability and trademark clearance are complete.

## Next gate

Run a real Shopify development-store install: OAuth, webhook signature checks, a controlled order → alert → provider callback flow, reconciliation, and test-mode billing. This is a test-store milestone, not public merchant launch approval.
