import { Link, useLoaderData } from "react-router";
import { PublicPage, Section, styles } from "../components/PublicPage";
import { PLAN_FEATURES } from "../lib/billing/plans.server";
import { env } from "../lib/env.server";

export function meta() {
  return [
    { title: "AlertProof — proof-of-delivery order alerts for Shopify" },
    {
      name: "description",
      content:
        "Multi-channel staff alerts for Shopify orders, with a delivery log that proves every alert was actually delivered — plus reconciliation that catches missed webhooks.",
    },
  ];
}

export function loader() {
  return {
    supportEmail: env.SUPPORT_EMAIL,
    plans: Object.values(PLAN_FEATURES).map((plan) => ({
      name: plan.name,
      monthlyPriceUsd: plan.monthlyPriceUsd,
      channels: plan.channels.join(", ").toLowerCase(),
      maxRules: plan.maxRules,
      retentionDays: plan.retentionDays,
      ordersPerMonth: plan.ordersPerMonth,
    })),
  };
}

export default function Index() {
  const { plans, supportEmail } = useLoaderData<typeof loader>();

  return (
    <PublicPage
      title="Order alerts your staff actually receive."
      intro="AlertProof sends multi-channel alerts on the Shopify order events you care about — and keeps a delivery log that proves each one arrived. When a webhook goes missing, reconciliation catches it."
    >
      <Section heading="Why it exists">
        <p>
          Most alert apps tell you a message was <em>sent</em>. That is not the
          same as delivered. AlertProof records the provider&apos;s own delivery
          and bounce callbacks against every message, so &ldquo;we never got the
          alert&rdquo; is answerable with evidence instead of a guess.
        </p>
      </Section>

      <Section heading="What it does">
        <ul style={styles.list}>
          <li>
            <strong>Rules per event.</strong> Trigger on order created, order
            paid, refund created, high-value orders, or low inventory.
          </li>
          <li>
            <strong>Multi-channel delivery.</strong> Email, Slack, Discord, and
            SMS, per recipient and per rule.
          </li>
          <li>
            <strong>Proof of delivery.</strong> A per-message log of sent,
            delivered, bounced, and failed states sourced from provider
            callbacks — not from optimistic local state.
          </li>
          <li>
            <strong>Reconciliation.</strong> Orders are re-checked against the
            Shopify Admin API, so a webhook Shopify never delivered still
            produces exactly one alert — never a duplicate.
          </li>
          <li>
            <strong>Escalation.</strong> On Pro, a bounced or failed alert
            escalates to a backup channel automatically.
          </li>
          <li>
            <strong>Write-back.</strong> Delivery status is written back onto
            the order, so the record of who was notified lives with the order
            itself.
          </li>
        </ul>
      </Section>

      <Section heading="Plans">
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Plan</th>
              <th style={styles.th}>Price</th>
              <th style={styles.th}>Rules</th>
              <th style={styles.th}>Channels</th>
              <th style={styles.th}>Log retention</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr key={plan.name}>
                <td style={styles.td}>{plan.name}</td>
                <td style={styles.td}>
                  {plan.monthlyPriceUsd === 0
                    ? "Free"
                    : `$${plan.monthlyPriceUsd}/mo`}
                </td>
                <td style={styles.td}>{plan.maxRules ?? "Unlimited"}</td>
                <td style={styles.td}>{plan.channels}</td>
                <td style={styles.td}>
                  {plan.retentionDays === null
                    ? "Unlimited"
                    : `${plan.retentionDays} days`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          The Free plan covers up to{" "}
          {plans.find((plan) => plan.monthlyPriceUsd === 0)?.ordersPerMonth ??
            50}{" "}
          orders per month. Billing is handled by Shopify and appears on your
          regular Shopify invoice; you can change or cancel your plan at any
          time from the app.
        </p>
      </Section>

      <Section heading="Install">
        <p>
          AlertProof installs from the Shopify App Store and runs entirely
          inside your Shopify admin. It requests only the scopes it needs to
          read orders and inventory and to write delivery status back to the
          order: <code>read_orders</code>, <code>write_orders</code>,{" "}
          <code>read_products</code>, and <code>read_inventory</code>.
        </p>
        <p>
          Questions before installing? See <Link to="/support">Support</Link> or
          email <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
        </p>
      </Section>
    </PublicPage>
  );
}
