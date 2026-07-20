import type { ShopifyOrder } from "../ports";

export const SHOPIFY_TOPICS = {
  APP_UNINSTALLED: "app/uninstalled",
  CUSTOMERS_DATA_REQUEST: "customers/data_request",
  CUSTOMERS_REDACT: "customers/redact",
  INVENTORY_LEVELS_UPDATE: "inventory_levels/update",
  ORDERS_CREATE: "orders/create",
  ORDERS_PAID: "orders/paid",
  ORDER_TRANSACTIONS_CREATE: "order_transactions/create",
  REFUNDS_CREATE: "refunds/create",
  SHOP_REDACT: "shop/redact",
} as const;

export type ShopifyTopic = (typeof SHOPIFY_TOPICS)[keyof typeof SHOPIFY_TOPICS];

export function canonicalizeTopic(topic: string): string {
  const normalized = topic.trim().toLowerCase();
  return normalized.includes("/")
    ? normalized
    : normalized.replace(/_([^_]*)$/, "/$1");
}

export function extractOrderId(
  topic: string,
  payload: Record<string, unknown>,
): string | null {
  const canonicalTopic = canonicalizeTopic(topic);
  const raw =
    canonicalTopic === SHOPIFY_TOPICS.REFUNDS_CREATE ||
    canonicalTopic === SHOPIFY_TOPICS.ORDER_TRANSACTIONS_CREATE
      ? payload.order_id
      : canonicalTopic.startsWith("orders/")
        ? payload.id
        : undefined;

  return typeof raw === "string" || typeof raw === "number"
    ? String(raw)
    : null;
}

export function extractResourceId(
  topic: string,
  payload: Record<string, unknown>,
): string | null {
  const canonicalTopic = canonicalizeTopic(topic);
  const raw =
    canonicalTopic === SHOPIFY_TOPICS.REFUNDS_CREATE ||
    canonicalTopic === SHOPIFY_TOPICS.ORDER_TRANSACTIONS_CREATE
      ? payload.id
      : canonicalTopic.startsWith("orders/")
        ? payload.id
        : undefined;
  return typeof raw === "string" || typeof raw === "number"
    ? String(raw)
    : null;
}

export type ExpectedOrderEvent = {
  topic: "orders/create" | "orders/paid" | "refunds/create";
  orderId: string;
  resourceId: string;
  syntheticWebhookId: string;
};

const PAID_STATUSES = new Set(["paid", "partially_paid"]);

/**
 * Phase 4 reconciliation consumes this per-topic expected-event set. Keeping the
 * derivation here makes a received create event independent from a later paid or
 * refund event, so out-of-order delivery never suppresses an expected event.
 */
export function expectedEventsForOrder(
  shopDomain: string,
  order: ShopifyOrder,
): ExpectedOrderEvent[] {
  const events: ExpectedOrderEvent[] = [
    {
      topic: SHOPIFY_TOPICS.ORDERS_CREATE,
      orderId: order.id,
      resourceId: order.id,
      syntheticWebhookId: `recon:${shopDomain}:orders/create:${order.id}`,
    },
  ];

  if (PAID_STATUSES.has(order.financialStatus?.toLowerCase() ?? "")) {
    events.push({
      topic: SHOPIFY_TOPICS.ORDERS_PAID,
      orderId: order.id,
      resourceId: order.id,
      syntheticWebhookId: `recon:${shopDomain}:orders/paid:${order.id}`,
    });
  }

  for (const refund of order.refunds) {
    events.push({
      topic: SHOPIFY_TOPICS.REFUNDS_CREATE,
      orderId: order.id,
      resourceId: refund.id,
      syntheticWebhookId: `recon:${shopDomain}:refunds/create:${refund.id}`,
    });
  }

  return events;
}
