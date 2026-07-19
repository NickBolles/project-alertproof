# MVP Spec: Shopify Staff Notification / Order-Alert App
### Working name: "AlertProof" (placeholder) · Target: $9–15/mo · Build window: 4–6 weeks at 10–20 hrs/wk

---

## 1. The One-Sentence Pitch

**"Never miss an order again — reliable staff alerts on every channel, with a delivery log that proves each one arrived."**

The wedge is verified merchant pain: Shopify's built-in staff order notification emails silently fail to deliver, merchants have no way to see whether an alert for a given order was ever sent, and Shopify's answer in its own forums was "contact support." We sell *reliability + proof*, not just another notifier.

## 2. Target Customer

Small-to-mid merchants (1–20 staff) where a missed order alert costs real money or reputation: made-to-order goods, food/florists with same-day fulfillment, high-AOV stores, stores with warehouse/fulfillment staff who work out of Slack/phones rather than Shopify admin. Subscription-fatigue-proof framing: this app *prevents lost orders*, it isn't a nice-to-have.

## 3. MVP Feature Set (build exactly this, nothing more)

**Core (weeks 1–4):**

1. **Alert rules engine (simple).** Trigger on: new order, order value ≥ X, specific product/collection ordered, low stock threshold, refund created, payment failed. Each rule routes to one or more recipients/channels.
2. **Multi-channel delivery.** Email (via a real transactional provider — Resend/Postmark, not Shopify's mailer), Slack (incoming webhook), Discord (webhook), SMS (Twilio, Pro tier only). Per-staff-member channel preferences.
3. **The delivery log (the moat feature).** Per order: which rules fired, which alerts were sent, to whom, on which channel, with provider-confirmed delivery status (delivered/bounced/deferred) and timestamps. Surfaced two ways: a searchable log in the app, and an **order metafield/note so status is visible right on the order** in Shopify admin.
4. **Redundancy + escalation.** If email bounces or isn't opened within N minutes (Pro), re-send via second channel. This is the "never miss" promise made real.
5. **Daily digest.** Optional morning summary per staff member (orders overnight, alerts sent, anything that bounced). Cheap to build, high perceived value.

**Explicitly OUT of MVP:** browser push, mobile app, task assignment/workflows, analytics dashboards, multi-store, POS-specific features, AI anything. Add only when customers ask.

## 4. Architecture Sketch

- **Stack:** Shopify's Remix app template (their current recommended path — verify the latest template/API version when you start), Node, Postgres (Supabase fits your existing setup), hosted on Fly.io/Railway (~$10–20/mo). One repo, boring choices.
- **Ingest:** Shopify webhooks — `orders/create`, `orders/paid`, `refunds/create`, `inventory_levels/update`. **Critical reliability detail:** persist webhook payloads to a queue table immediately, ack fast, process async with retries — your app's whole brand is "we don't drop things," so build idempotent processing (dedupe on webhook ID) and a reconciliation cron that polls the Orders API every 15 min to catch any webhook Shopify failed to deliver. That reconciliation loop is what lets you honestly claim you're more reliable than Shopify's own emails.
- **Delivery + status:** Resend/Postmark webhooks give you bounce/delivery events → feed the delivery log. Slack/Discord webhooks return success synchronously. Twilio gives delivery receipts.
- **Billing:** Shopify Billing API, single recurring charge. 14-day free trial.
- **Embedded UI:** Polaris components so it feels native — a settings page (rules, recipients), the delivery log, and a "test my alerts" button that fires a fake order through the whole pipeline (this button will close sales; flaky-email victims are your buyers and they want proof on day one).

## 5. Pricing

- **Free:** 1 rule, email only, 7-day log retention, 50 orders/mo. (Exists to earn installs + reviews; the app store ranks on both.)
- **Standard $9/mo:** unlimited rules, email + Slack + Discord, 90-day log, delivery-status visibility.
- **Pro $19/mo:** SMS (metered fair-use or BYO-Twilio), escalation/re-send logic, daily digests, unlimited retention.

Flat pricing, no per-staff fees — deliberately the anti-per-seat position, and SMS costs are contained by BYO-Twilio.

## 6. Build Plan (6 weeks, ~10–15 hrs/wk, AI-assisted)

- **Wk 1:** Partner account, Remix template, OAuth + webhook ingest with queue + idempotency. Ship "hello order" to your own test store.
- **Wk 2:** Rules engine + email via Postmark with delivery webhooks feeding the log.
- **Wk 3:** Slack/Discord channels, per-staff preferences, delivery log UI + order note/metafield write-back.
- **Wk 4:** Billing API, free/paid gating, "test my alerts" button, reconciliation cron.
- **Wk 5:** Polish (Polaris, empty states, onboarding checklist), SMS + escalation behind Pro flag, App Store listing assets (screenshots, demo video ≤60s, keyword-researched listing copy: "order notifications," "staff alerts," "order alerts Slack").
- **Wk 6:** App review submission (budget 1–2 weeks review latency; use it for the launch checklist below). Fix review feedback fast.

## 7. Launch & Distribution (the part that actually matters)

1. **App Store SEO first:** the listing is your storefront — keywords in title/subtitle, all 6 screenshot slots, video. Reviews are the ranking currency: in-app review ask after a user's first *caught* failure or 2 weeks of clean delivery ("We've delivered 214 alerts for you — mind leaving a review?").
2. **Answer the actual complaint threads.** The exact Shopify Community threads from the research (staff notifications not arriving — threads 181100, 102044, and successors) get a helpful, non-spammy reply explaining the fix and mentioning the app. Set a saved search / weekly AI agent to find *new* threads with those symptoms — this is your automated lead-gen.
3. **r/shopify presence:** answer notification/webhook questions weekly (value first, app in profile).
4. **Content:** 3–4 SEO posts targeting long-tails you can win: "Shopify staff order notifications not working," "get Shopify order alerts in Slack," "Shopify order notification delivery log." Low volume but perfect intent, and AI drafts them.
5. **Milestone math:** at $9–19 blended (~$12 avg), 25–50 paying stores = $300–600/mo. Uptime's 31-reviews-in-4-years warns this niche converts slowly from listing alone — the forum-thread channel is the accelerant.

## 8. Risks & Honest Unknowns

- **Shopify could fix their notifications.** Mitigation: multi-channel routing + rules + escalation remain valuable even if base email gets reliable; the delivery log is still unique.
- **Incumbent check needed at kickoff:** search the app store for "order notifications"/"staff alerts" the week you start — the v2 research validated the complaint, not the absence of competitors. If a strong incumbent exists, the delivery-log + escalation wedge is your differentiation; verify none of them has it.
- **Notification apps under-collect reviews** (they work silently in the background) — hence the engineered review-ask moment in §7.
- **80% of merchants who install apps churn or go dormant within a couple months** [raw stat from pass 1] — the daily digest exists partly to stay visible and fight this.

---
*Verify current Shopify API versioning, webhook topics, and app-review requirements against the dev docs at build time — this spec was written 2026-07-18.*
