import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import prisma from "../db.server";
import { createAdapters } from "../lib/adapters/index.server";
import { authenticateAdmin } from "../lib/auth.server";
import { requeueDeadEvents } from "../lib/ingest/processor.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticateAdmin(request);
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
    include: {
      _count: { select: { rules: true, recipients: true } },
      reconciliationRuns: { orderBy: { startedAt: "desc" }, take: 1 },
    },
  });
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [deadWebhookEvents, sent, delivered, testEvents] = await Promise.all([
    prisma.webhookEvent.count({
      where: { shopDomain: session.shop, status: "DEAD" },
    }),
    prisma.delivery.count({
      where: {
        alert: { shopId: shop.id, firedAt: { gte: since } },
        status: { in: ["SENT", "DELIVERED"] },
      },
    }),
    prisma.delivery.count({
      where: {
        alert: { shopId: shop.id, firedAt: { gte: since } },
        status: "DELIVERED",
      },
    }),
    prisma.webhookEvent.count({
      where: { shopDomain: session.shop, source: "TEST" },
    }),
  ]);
  return {
    shopDomain: session.shop,
    deadWebhookEvents,
    ruleCount: shop._count.rules,
    recipientCount: shop._count.recipients,
    testRun: testEvents > 0,
    alertsSent7d: sent,
    deliveryRate: sent === 0 ? null : Math.round((delivered / sent) * 100),
    lastMissedCount: shop.reconciliationRuns[0]?.missedFound ?? null,
    mode: createAdapters().mode,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await authenticateAdmin(request);
  const form = await request.formData();
  if (form.get("intent") !== "requeue-dead") {
    return Response.json({ error: "Unknown action" }, { status: 400 });
  }
  return Response.json({ requeued: await requeueDeadEvents() });
}

export type DashboardData = Awaited<ReturnType<typeof loader>>;

export function DashboardView({ data }: { data: DashboardData }) {
  return (
    <s-page heading="AlertProof">
      {data.deadWebhookEvents > 0 ? (
        <s-banner tone="critical" heading="Webhook events need attention">
          <s-paragraph>
            {data.deadWebhookEvents} events are dead-lettered.
          </s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="requeue-dead" />
            <s-button type="submit">Requeue events</s-button>
          </Form>
        </s-banner>
      ) : null}
      <s-section heading="Onboarding checklist">
        <s-paragraph>
          {data.ruleCount > 0 ? "✓" : "○"} Create an alert rule
        </s-paragraph>
        <s-paragraph>
          {data.recipientCount > 0 ? "✓" : "○"} Add a recipient
        </s-paragraph>
        <s-paragraph>{data.testRun ? "✓" : "○"} Run a test alert</s-paragraph>
        <Form method="post" action="/app/test-alerts">
          <s-button type="submit" variant="primary">
            Test my alerts
          </s-button>
        </Form>
      </s-section>
      <s-section heading="Last 7 days">
        <s-paragraph>Alerts sent: {data.alertsSent7d}</s-paragraph>
        <s-paragraph>
          Delivery rate:{" "}
          {data.deliveryRate === null
            ? "No deliveries yet"
            : `${data.deliveryRate}%`}
        </s-paragraph>
        <s-paragraph>
          Last reconciliation misses: {data.lastMissedCount ?? "Not run yet"}
        </s-paragraph>
      </s-section>
      <s-section heading="Provider modes">
        <s-paragraph>
          Email:{" "}
          {data.mode.email === "mock"
            ? "MOCK MODE — set POSTMARK_API_TOKEN to go live"
            : "Postmark"}
        </s-paragraph>
        <s-paragraph>
          SMS:{" "}
          {data.mode.sms === "mock"
            ? "MOCK MODE — set Twilio credentials to go live"
            : "Twilio"}
        </s-paragraph>
        <s-paragraph>
          Shopify Admin: {data.mode.shopifyAdmin.toUpperCase()}
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export default function AppIndex() {
  return <DashboardView data={useLoaderData<typeof loader>()} />;
}
