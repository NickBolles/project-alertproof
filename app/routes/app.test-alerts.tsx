import type { ActionFunctionArgs } from "react-router";
import { Form, useActionData } from "react-router";
import { authenticateAdmin } from "../lib/auth.server";
import { runSyntheticTestAlert } from "../lib/ui/test-alert.server";

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticateAdmin(request);
  const alerts = await runSyntheticTestAlert({ shopDomain: session.shop });
  return {
    orderName: alerts[0]?.orderName ?? null,
    alerts: alerts.map((alert) => ({
      id: alert.id,
      ruleName: alert.rule?.name ?? "Alert",
      deliveries: alert.deliveries.map((delivery) => ({
        id: delivery.id,
        recipient: delivery.recipient.name,
        channel: delivery.channel,
        status: delivery.status,
        reason: delivery.lastError,
      })),
    })),
  };
}
export default function TestAlertsPage() {
  const result = useActionData<typeof action>();
  return (
    <s-page heading="Test my alerts">
      <s-section>
        {result ? (
          <>
            <s-heading>{result.orderName ?? "Synthetic order"}</s-heading>
            {result.alerts.length === 0 ? (
              <s-banner tone="warning">
                No enabled rules matched the synthetic order. Create an
                order-created rule first.
              </s-banner>
            ) : (
              result.alerts.map((alert) => (
                <div key={alert.id}>
                  <s-heading>{alert.ruleName}</s-heading>
                  {alert.deliveries.map((delivery) => (
                    <s-paragraph key={delivery.id}>
                      {delivery.status === "DELIVERED" ? "✓" : delivery.status}{" "}
                      {delivery.channel} → {delivery.recipient}
                      {delivery.reason ? ` — ${delivery.reason}` : ""}
                    </s-paragraph>
                  ))}
                </div>
              ))
            )}
          </>
        ) : (
          <s-paragraph>
            Run a synthetic order through the webhook, rules, delivery, and log
            pipeline.
          </s-paragraph>
        )}
        <Form method="post">
          <s-button type="submit" variant="primary">
            Run test again
          </s-button>
        </Form>
      </s-section>
    </s-page>
  );
}
