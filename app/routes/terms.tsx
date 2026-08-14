import { Link, useLoaderData } from "react-router";
import { PublicPage, Section, styles } from "../components/PublicPage";
import { PLAN_FEATURES } from "../lib/billing/plans.server";
import { env } from "../lib/env.server";

export function meta() {
  return [
    { title: "Terms of service — AlertProof" },
    {
      name: "description",
      content:
        "The terms that apply to using AlertProof on a Shopify store: what the app does, what it charges, and the limits of what it guarantees.",
    },
  ];
}

export function loader() {
  return {
    supportEmail: env.SUPPORT_EMAIL,
    freeOrdersPerMonth: PLAN_FEATURES.FREE.ordersPerMonth,
  };
}

export default function Terms() {
  const { supportEmail, freeOrdersPerMonth } = useLoaderData<typeof loader>();

  return (
    <PublicPage
      title="Terms of service"
      updated="13 August 2026"
      intro="These terms apply to any Shopify store that installs AlertProof."
    >
      <Section heading="The service">
        <p>
          AlertProof sends notifications about events in your Shopify store to
          recipients you configure, and records the delivery outcome of each
          notification. Access requires an active Shopify store and the app
          installed on it.
        </p>
      </Section>

      <Section heading="Your responsibilities">
        <ul style={styles.list}>
          <li>
            You confirm you have the right to send notifications to the
            recipients you add, and that they expect to receive them. This
            matters especially for SMS.
          </li>
          <li>
            You are responsible for keeping recipient addresses and webhook URLs
            accurate.
          </li>
          <li>
            You may not use the app to send unsolicited marketing, or to send to
            recipients who have not agreed to be contacted.
          </li>
        </ul>
      </Section>

      <Section heading="Billing">
        <p>
          Paid plans are billed monthly through Shopify and appear on your
          Shopify invoice. The Free plan is limited to {freeOrdersPerMonth}{" "}
          orders per month. You may change or cancel your plan at any time from
          the app; cancellation takes effect at the end of the current billing
          period and no partial-period refunds are issued. Prices may change
          with at least 30 days&apos; notice.
        </p>
      </Section>

      <Section heading="Availability and limits">
        <p>
          AlertProof depends on services it does not control — Shopify&apos;s
          webhooks and Admin API, and the email, chat, and SMS providers that
          carry each message. The app is built to survive their failures:
          undelivered webhooks are reconciled from the Admin API, and failed
          messages are retried and logged. Even so, the service is provided
          &ldquo;as is&rdquo;, without a warranty that every notification will
          be delivered or delivered on time.
        </p>
        <p>
          Do not rely on AlertProof as the sole safeguard for a process where a
          missed notification would cause serious harm. To the maximum extent
          permitted by law, liability arising from use of the app is limited to
          the amount you paid for it in the twelve months preceding the claim.
        </p>
      </Section>

      <Section heading="Data">
        <p>
          Data handling is described in the{" "}
          <Link to="/privacy">privacy policy</Link>, which forms part of these
          terms.
        </p>
      </Section>

      <Section heading="Termination">
        <p>
          You may stop using the app at any time by uninstalling it from your
          Shopify admin. We may suspend an account that is being used to send
          unsolicited messages or that is abusing the service, with notice where
          practical.
        </p>
      </Section>

      <Section heading="Changes and contact">
        <p>
          Material changes to these terms will be reflected in the &ldquo;last
          updated&rdquo; date above and announced in-app before taking effect.
          Questions: <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
        </p>
      </Section>
    </PublicPage>
  );
}
