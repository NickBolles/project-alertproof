# AlertProof — Reliable Staff Order Alerts for Shopify

> **Never miss an order again — staff alerts on every channel, with a delivery log that proves each one arrived.**

**Status:** production-ready build · **Plans:** Free, Standard $9, Pro $19

## Why this exists

Verified research (July 2026, two adversarial deep-research passes):

- Shopify's built-in staff order notification emails **silently fail to deliver** — documented in multiple Shopify Community threads (e.g. threads 181100, 102044): test emails work, real orders "just disappear," delivery is inconsistent per-inbox.
- Merchants explicitly asked for **per-order delivery-status visibility**. Shopify staff offered no fix.
- The "staff notifications" app category showed **+161% growth** in merchant search page views (Shopify-attributed 2024 data).

The product is the fix: rule-based multi-channel alerts (email/Slack/Discord/SMS) with provider-confirmed delivery logging written back to each order, redundancy, and escalation.

## Key docs

- [`PLAN.md`](./PLAN.md) — full MVP spec: features, architecture, 6-week build plan, pricing, launch strategy, risks.
- [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) — authoritative phased build contract.
- [`docs/GOING_LIVE.md`](./docs/GOING_LIVE.md) — production credentials, deploy, cron, and app-review handoff.

## Phase 0 local development

Requirements: Node 20.19+ and PostgreSQL 16. Copy `.env.example` to `.env`, then run:

```powershell
docker compose up -d
npm install
npm run setup
npm run dev
```

On Windows, native PostgreSQL is also supported: point `DATABASE_URL` at it and skip the
Docker command. External provider credentials are optional; absent credentials select working
MockOutbox-backed adapters. Real Shopify OAuth alone requires Partner credentials.

With `ALERTPROOF_FORCE_MOCKS=1`, email, chat, and SMS are written to `MockOutbox`; the guarded
`/dev/mock` screen can inspect sends and simulate provider results. The in-process worker handles
queue draining, reconciliation, Pro escalation/digests, and retention. The same jobs can be
invoked with a CRON bearer token under `/internal/cron/*`.

Verification commands are `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test`.
The opt-in 500-event performance check requires a disposable database and
`ALERTPROOF_PERF_TEST=1 npm run perf:sanity`.

The authoritative implementation plan is [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md),
with build-time decisions recorded in [`docs/DECISIONS.md`](./docs/DECISIONS.md).

## Kickoff Prompt

Paste this into Claude Code from the repo root to start:

```
Read PLAN.md carefully. You are helping me build AlertProof, a Shopify embedded app,
as a solo developer working ~10-15 hrs/week with a 6-week MVP target.

Phase 0 — verify before building (do this first):
1. Check the current Shopify docs for the recommended app scaffold (Remix template or
   successor), current API version, webhook topics (orders/create, orders/paid,
   refunds/create, inventory_levels/update), and Billing API patterns. Flag anything
   in PLAN.md that's outdated.
2. Search the Shopify App Store for current "staff order notifications" / "order alerts"
   apps. List the top 5 with pricing and features, and confirm whether any already offers
   a per-order delivery log. If one does, propose how we differentiate before writing code.

Phase 1 — plan:
3. Produce docs/ARCHITECTURE.md: chosen stack, data model (rules, recipients, deliveries,
   webhook queue), the idempotent webhook ingestion design, the reconciliation cron, and
   the delivery-status pipeline (Postmark/Resend webhooks -> delivery log -> order metafield).
4. Produce a week-by-week issue breakdown matching PLAN.md's build plan, as GitHub issues
   I can create (title + description + acceptance criteria each).

Phase 2 — scaffold:
5. Initialize the app scaffold, dev store config, and CI (lint + typecheck + test on push).
   Stop and show me the running "hello order" webhook demo before building features.

Constraints: boring stack (Node/TS, Postgres), everything idempotent, reliability is the
brand — no dropped webhooks, ever. Ask me before adding any dependency beyond the scaffold.
```

## Portfolio context

Part of a 4-product plan (see the other repos: `skuforge`, `checkoutwatch`, `ticketpilot`). AlertProof ships first; its alert-delivery layer (multi-channel send + delivery confirmation) is designed for reuse in CheckoutWatch.
