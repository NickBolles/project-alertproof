import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import prisma from "../db.server";
import { authenticateAdmin } from "../lib/auth.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticateAdmin(request);
  return {
    alerts: await prisma.alert.findMany({
      where: { shop: { shopDomain: session.shop }, orderId: params.orderId },
      include: { rule: true, deliveries: { include: { recipient: true } } },
      orderBy: { firedAt: "desc" },
    }),
  };
}
export default function OrderLogPage() {
  const { alerts } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Order delivery timeline">
      <s-section>
        {alerts.map((alert) => (
          <div key={alert.id}>
            <s-heading>{alert.rule?.name ?? "Alert"}</s-heading>
            {alert.deliveries.map((delivery) => (
              <s-paragraph key={delivery.id}>
                {delivery.channel}: {delivery.status}
                {delivery.lastError ? ` — ${delivery.lastError}` : ""}
              </s-paragraph>
            ))}
          </div>
        ))}
      </s-section>
    </s-page>
  );
}
