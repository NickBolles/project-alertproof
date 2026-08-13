import { Link, useLoaderData } from "react-router";
import { PublicPage, Section, styles } from "../components/PublicPage";
import { env } from "../lib/env.server";

export function meta() {
  return [
    { title: "Support — AlertProof" },
    {
      name: "description",
      content:
        "How to get help with AlertProof, plus answers to the questions merchants ask most about alerts, delivery proof, and reconciliation.",
    },
  ];
}

export function loader() {
  return { supportEmail: env.SUPPORT_EMAIL };
}

export default function Support() {
  const { supportEmail } = useLoaderData<typeof loader>();

  return (
    <PublicPage
      title="Support"
      intro="Email support is the fastest route. Include your store domain and, if the question is about a specific alert, the order number — the delivery log is searchable by order."
    >
      <Section heading="Contact">
        <p>
          <a href={`mailto:${supportEmail}`}>{supportEmail}</a> — responses
          within one business day.
        </p>
      </Section>

      <Section heading="An alert did not arrive">
        <ol style={styles.list}>
          <li>
            Open <strong>Delivery log</strong> in the app and search for the
            order number. Every attempt is listed with its status.
          </li>
          <li>
            If the status is <strong>bounced</strong>, the recipient&apos;s mail
            server rejected the message — check the address, or check whether
            the recipient marked an earlier alert as spam.
          </li>
          <li>
            If the status is <strong>delivered</strong>, the provider accepted
            and delivered it; check the recipient&apos;s spam folder and any
            inbox rules.
          </li>
          <li>
            If there is no entry for the order at all, the rule may not have
            matched. Check the rule&apos;s trigger and conditions, and confirm
            the rule is enabled.
          </li>
        </ol>
      </Section>

      <Section heading="Common questions">
        <h3 style={styles.h3}>
          What happens if Shopify never sends a webhook?
        </h3>
        <p>
          AlertProof periodically re-reads recent orders from the Shopify Admin
          API and compares them against the events it actually received. A
          missing event is replayed and produces exactly one alert — the
          deduplication key makes a recovered event and a late-arriving webhook
          collapse to a single alert rather than two.
        </p>

        <h3 style={styles.h3}>Does an alert ever get sent twice?</h3>
        <p>
          No. Alerts are deduplicated per store on a key derived from the event
          and rule, and each individual message is unique on recipient, channel,
          and destination.
        </p>

        <h3 style={styles.h3}>How do I send SMS?</h3>
        <p>
          SMS is a Pro feature and uses your own Twilio account. Add your Twilio
          credentials in Settings; they are encrypted at rest. Without
          credentials, SMS recipients are skipped rather than silently failing.
        </p>

        <h3 style={styles.h3}>Where do Slack and Discord alerts go?</h3>
        <p>
          To the incoming-webhook URL you paste when creating the recipient.
          Both URLs are stored encrypted. Use <strong>Test alerts</strong> in
          the app to confirm a new recipient works before relying on it.
        </p>

        <h3 style={styles.h3}>What does the app write back to my orders?</h3>
        <p>
          A record of which alert fired and whether it was delivered, so the
          notification history lives with the order. This is why the app
          requests the <code>write_orders</code> scope. It never changes order
          contents, fulfillment, or pricing.
        </p>

        <h3 style={styles.h3}>How do I change or cancel my plan?</h3>
        <p>
          From <strong>Billing</strong> in the app. Charges are processed by
          Shopify and appear on your Shopify invoice. Cancelling returns the
          store to the Free plan at the end of the billing period.
        </p>

        <h3 style={styles.h3}>What happens when I uninstall?</h3>
        <p>
          Access tokens and sessions are deleted immediately, and the rest of
          your data is deleted when Shopify issues its <code>shop/redact</code>{" "}
          request 48 hours later. See the{" "}
          <Link to="/privacy">privacy policy</Link> for the full retention
          detail.
        </p>
      </Section>

      <Section heading="Reporting a security issue">
        <p>
          Email <a href={`mailto:${supportEmail}`}>{supportEmail}</a> with
          &ldquo;security&rdquo; in the subject. Please do not open a public
          issue for a suspected vulnerability.
        </p>
      </Section>
    </PublicPage>
  );
}
