import { Channel, DeliveryStatus, type Prisma } from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData } from "react-router";
import prisma from "../db.server";
import { authenticateAdmin } from "../lib/auth.server";

function enumValue<T extends string>(
  value: string | null,
  values: readonly T[],
): T | undefined {
  return value && values.includes(value as T) ? (value as T) : undefined;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticateAdmin(request);
  const url = new URL(request.url);
  const order = url.searchParams.get("order")?.trim() || undefined;
  const status = enumValue(
    url.searchParams.get("status"),
    Object.values(DeliveryStatus),
  );
  const channel = enumValue(
    url.searchParams.get("channel"),
    Object.values(Channel),
  );
  const beforeRaw = url.searchParams.get("before");
  const before =
    beforeRaw && !Number.isNaN(Date.parse(beforeRaw))
      ? new Date(beforeRaw)
      : undefined;
  const fromRaw = url.searchParams.get("from");
  const from =
    fromRaw && !Number.isNaN(Date.parse(fromRaw))
      ? new Date(fromRaw)
      : undefined;
  const where: Prisma.AlertWhereInput = {
    shop: { shopDomain: session.shop },
    firedAt: {
      ...(before ? { lt: before } : {}),
      ...(from ? { gte: from } : {}),
    },
    ...(order
      ? {
          OR: [
            { orderName: { contains: order, mode: "insensitive" } },
            { orderId: { contains: order, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(status || channel ? { deliveries: { some: { status, channel } } } : {}),
  };
  const alerts = await prisma.alert.findMany({
    where,
    include: {
      rule: { select: { name: true } },
      deliveries: {
        where: { status, channel },
        include: { recipient: { select: { name: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: [{ firedAt: "desc" }, { id: "desc" }],
    take: 26,
  });
  const hasMore = alerts.length > 25;
  const page = alerts.slice(0, 25);
  return {
    shopDomain: session.shop,
    alerts: page.map((alert) => ({
      ...alert,
      orderValue: alert.orderValue?.toString() ?? null,
    })),
    filters: {
      order: order ?? "",
      status: status ?? "",
      channel: channel ?? "",
      from: fromRaw ?? "",
    },
    nextCursor: hasMore ? (page.at(-1)?.firedAt.toISOString() ?? null) : null,
  };
}

export type DeliveryLogData = Awaited<ReturnType<typeof loader>>;

export function DeliveryLogView({ data }: { data: DeliveryLogData }) {
  return (
    <s-page heading="Delivery log">
      <s-section heading="Search and filter">
        <Form method="get">
          <s-text-field
            name="order"
            label="Order name or ID"
            value={data.filters.order}
          />
          <label>
            Status
            <select name="status" defaultValue={data.filters.status}>
              <option value="">All</option>
              {Object.values(DeliveryStatus).map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Channel
            <select name="channel" defaultValue={data.filters.channel}>
              <option value="">All</option>
              {Object.values(Channel).map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            From date
            <input name="from" type="date" defaultValue={data.filters.from} />
          </label>
          <s-button type="submit">Filter</s-button>
        </Form>
      </s-section>
      <s-section heading="Alerts">
        {data.alerts.length === 0 ? (
          <s-paragraph>No delivery records match these filters.</s-paragraph>
        ) : (
          data.alerts.map((alert) => (
            <details key={alert.id}>
              <summary>
                {alert.orderName ?? alert.orderId ?? "Non-order alert"} ·{" "}
                {alert.rule?.name ?? "Alert"} ·{" "}
                {new Date(alert.firedAt).toLocaleString()}
              </summary>
              {alert.orderId ? (
                <s-paragraph>
                  <a
                    href={`https://${data.shopDomain}/admin/orders/${encodeURIComponent(alert.orderId)}`}
                  >
                    Open order in Shopify
                  </a>
                </s-paragraph>
              ) : null}
              {alert.deliveries.map((delivery) => (
                <s-paragraph key={delivery.id}>
                  {delivery.channel} → {delivery.recipient.name}:{" "}
                  {delivery.status}
                  {delivery.lastError ? ` — ${delivery.lastError}` : ""} ·{" "}
                  {delivery.statusAt
                    ? new Date(delivery.statusAt).toLocaleString()
                    : "queued"}
                </s-paragraph>
              ))}
            </details>
          ))
        )}
        {data.nextCursor ? (
          <Link to={`?before=${encodeURIComponent(data.nextCursor)}`}>
            Next page
          </Link>
        ) : null}
      </s-section>
    </s-page>
  );
}

export default function DeliveryLogPage() {
  return <DeliveryLogView data={useLoaderData<typeof loader>()} />;
}
