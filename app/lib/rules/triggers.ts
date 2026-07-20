import { Trigger } from "@prisma/client";
import { canonicalizeTopic, SHOPIFY_TOPICS } from "../ingest/topics";

export type OrderFacts = {
  topic: "orders/create" | "orders/paid";
  orderId: string;
  orderName: string | null;
  totalPrice: string | null;
  lineItemProductIds: string[];
  lineItemCollectionIds: string[];
};

export type RefundFacts = {
  topic: "refunds/create";
  orderId: string;
  orderName: string | null;
  refundId: string;
};

export type PaymentFailedFacts = {
  topic: "order_transactions/create";
  orderId: string;
  orderName: string | null;
  transactionId: string;
  transactionStatus: string;
};

export type InventoryFacts = {
  topic: "inventory_levels/update";
  inventoryItemId: string;
  locationId: string;
  available: number;
  previousAvailable: number | null;
  epoch: number;
};

export type TriggerFacts =
  OrderFacts | RefundFacts | PaymentFailedFacts | InventoryFacts;

function id(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

export function extractTriggerFacts(
  topic: string,
  payload: Record<string, unknown>,
): TriggerFacts | null {
  const canonicalTopic = canonicalizeTopic(topic);
  if (
    canonicalTopic === SHOPIFY_TOPICS.ORDERS_CREATE ||
    canonicalTopic === SHOPIFY_TOPICS.ORDERS_PAID
  ) {
    const orderId = id(payload.id);
    if (!orderId) return null;
    return {
      topic: canonicalTopic,
      orderId,
      orderName: stringValue(payload.name),
      totalPrice: stringValue(payload.total_price),
      lineItemProductIds: records(payload.line_items)
        .map((item) => id(item.product_id))
        .filter((productId): productId is string => productId !== null),
      lineItemCollectionIds: [],
    };
  }

  if (canonicalTopic === SHOPIFY_TOPICS.REFUNDS_CREATE) {
    const orderId = id(payload.order_id);
    const refundId = id(payload.id);
    if (!orderId || !refundId) return null;
    return {
      topic: canonicalTopic,
      orderId,
      orderName: stringValue(payload.order_name),
      refundId,
    };
  }

  if (canonicalTopic === SHOPIFY_TOPICS.ORDER_TRANSACTIONS_CREATE) {
    const orderId = id(payload.order_id);
    const transactionId = id(payload.id);
    if (!orderId || !transactionId) return null;
    return {
      topic: canonicalTopic,
      orderId,
      orderName: stringValue(payload.order_name),
      transactionId,
      transactionStatus: stringValue(payload.status)?.toLowerCase() ?? "",
    };
  }

  if (canonicalTopic === SHOPIFY_TOPICS.INVENTORY_LEVELS_UPDATE) {
    const inventoryItemId = id(payload.inventory_item_id);
    const locationId = id(payload.location_id);
    const available = Number(payload.available);
    if (!inventoryItemId || !locationId || !Number.isInteger(available)) {
      return null;
    }
    return {
      topic: canonicalTopic,
      inventoryItemId,
      locationId,
      available,
      previousAvailable: null,
      epoch: 0,
    };
  }

  return null;
}

export type EvaluatedRule = {
  id: string;
  trigger: Trigger;
  enabled: boolean;
  conditions: unknown;
};

type Conditions = {
  minValue?: unknown;
  productIds?: unknown;
  collectionIds?: unknown;
  stockThreshold?: unknown;
};

function conditionsFor(rule: EvaluatedRule): Conditions {
  return typeof rule.conditions === "object" && rule.conditions !== null
    ? (rule.conditions as Conditions)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => id(item))
        .filter((item): item is string => item !== null)
    : [];
}

function decimalParts(value: unknown): { units: bigint; scale: number } | null {
  const raw = stringValue(value)?.trim();
  if (!raw || !/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return null;
  const negative = raw.startsWith("-");
  const unsigned = raw.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  const units = BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n);
  return { units, scale: fraction.length };
}

export function compareDecimalStrings(
  left: unknown,
  right: unknown,
): number | null {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  if (!leftParts || !rightParts) return null;
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const scaledLeft = leftParts.units * 10n ** BigInt(scale - leftParts.scale);
  const scaledRight =
    rightParts.units * 10n ** BigInt(scale - rightParts.scale);
  return scaledLeft === scaledRight ? 0 : scaledLeft > scaledRight ? 1 : -1;
}

function ruleMatches(rule: EvaluatedRule, facts: TriggerFacts): boolean {
  const conditions = conditionsFor(rule);
  switch (rule.trigger) {
    case Trigger.ORDER_CREATED:
      return facts.topic === SHOPIFY_TOPICS.ORDERS_CREATE;
    case Trigger.ORDER_PAID:
      return facts.topic === SHOPIFY_TOPICS.ORDERS_PAID;
    case Trigger.ORDER_VALUE_GTE:
      return (
        facts.topic === SHOPIFY_TOPICS.ORDERS_CREATE &&
        compareDecimalStrings(facts.totalPrice, conditions.minValue) !== null &&
        compareDecimalStrings(facts.totalPrice, conditions.minValue)! >= 0
      );
    case Trigger.PRODUCT_ORDERED: {
      if (facts.topic !== SHOPIFY_TOPICS.ORDERS_CREATE) return false;
      const productIds = new Set(stringArray(conditions.productIds));
      const collectionIds = new Set(stringArray(conditions.collectionIds));
      return (
        facts.lineItemProductIds.some((productId) =>
          productIds.has(productId),
        ) ||
        facts.lineItemCollectionIds.some((collectionId) =>
          collectionIds.has(collectionId),
        )
      );
    }
    case Trigger.LOW_STOCK: {
      if (
        facts.topic !== SHOPIFY_TOPICS.INVENTORY_LEVELS_UPDATE ||
        facts.previousAvailable === null
      ) {
        return false;
      }
      const threshold = Number(conditions.stockThreshold);
      return (
        Number.isInteger(threshold) &&
        facts.previousAvailable > threshold &&
        facts.available <= threshold
      );
    }
    case Trigger.REFUND_CREATED:
      return facts.topic === SHOPIFY_TOPICS.REFUNDS_CREATE;
    case Trigger.PAYMENT_FAILED:
      return (
        facts.topic === SHOPIFY_TOPICS.ORDER_TRANSACTIONS_CREATE &&
        facts.transactionStatus === "failure"
      );
  }
}

/** Pure, deterministic trigger evaluation. */
export function evaluate<T extends EvaluatedRule>(
  trigger: Trigger,
  facts: TriggerFacts,
  rules: readonly T[],
): T[] {
  return rules.filter(
    (rule) =>
      rule.enabled && rule.trigger === trigger && ruleMatches(rule, facts),
  );
}

export function evaluateAll<T extends EvaluatedRule>(
  facts: TriggerFacts,
  rules: readonly T[],
): T[] {
  return Object.values(Trigger).flatMap((trigger) =>
    evaluate(trigger, facts, rules),
  );
}

export function dedupeKeyForRule(
  rule: EvaluatedRule,
  facts: TriggerFacts,
): string {
  if (facts.topic === SHOPIFY_TOPICS.REFUNDS_CREATE) {
    return `${rule.id}:refunds/create:${facts.refundId}`;
  }
  if (facts.topic === SHOPIFY_TOPICS.ORDER_TRANSACTIONS_CREATE) {
    return `${rule.id}:order_transactions/create:${facts.transactionId}`;
  }
  if (facts.topic === SHOPIFY_TOPICS.INVENTORY_LEVELS_UPDATE) {
    const threshold = Number(conditionsFor(rule).stockThreshold);
    return `${rule.id}:low_stock:${facts.inventoryItemId}:${facts.locationId}:${threshold}:${facts.epoch}`;
  }
  return `${rule.id}:${facts.topic}:${facts.orderId}`;
}

export function orderSummary(facts: TriggerFacts): {
  orderId: string | null;
  orderName: string | null;
  orderValue: string | null;
} {
  if (facts.topic === SHOPIFY_TOPICS.INVENTORY_LEVELS_UPDATE) {
    return { orderId: null, orderName: null, orderValue: null };
  }
  return {
    orderId: facts.orderId,
    orderName: facts.orderName,
    orderValue: "totalPrice" in facts ? facts.totalPrice : null,
  };
}
