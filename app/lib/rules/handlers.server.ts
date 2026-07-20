import { randomUUID } from "node:crypto";
import {
  Channel,
  DeliveryStatus,
  Plan,
  Prisma,
  Trigger,
  type PrismaClient,
} from "@prisma/client";
import { createAdapters } from "../adapters/index.server";
import { channelAccessForPlan } from "../billing/features.server";
import { SHOPIFY_TOPICS } from "../ingest/topics";
import {
  registerTopicHandler,
  type ProcessableWebhookEvent,
  type TopicHandler,
} from "../ingest/processor.server";
import type { ShopifyAdmin } from "../ports";
import {
  dedupeKeyForRule,
  evaluateAll,
  extractTriggerFacts,
  orderSummary,
  type InventoryFacts,
  type OrderFacts,
  type TriggerFacts,
} from "./triggers";

type RuleWithRecipients = Prisma.RuleGetPayload<{
  include: { recipients: { include: { recipient: true } } };
}>;
type TransactionClient = Parameters<
  Parameters<PrismaClient["$transaction"]>[0]
>[0];

const PRODUCT_CACHE_MS = 10 * 60_000;
const productCache = new Map<
  string,
  { expiresAt: number; collectionIds: string[] }
>();

export function clearProductCollectionCache(): void {
  productCache.clear();
}

async function collectionIdsForProducts(input: {
  shopDomain: string;
  productIds: string[];
  shopifyAdmin: ShopifyAdmin;
  now: Date;
}): Promise<string[]> {
  const memberships = await Promise.all(
    [...new Set(input.productIds)].map(async (productId) => {
      const cacheKey = `${input.shopDomain}:${productId}`;
      const cached = productCache.get(cacheKey);
      if (cached && cached.expiresAt > input.now.getTime()) {
        return cached.collectionIds;
      }
      const product = await input.shopifyAdmin.getProduct({
        shopDomain: input.shopDomain,
        productId,
      });
      const collectionIds = product?.collectionIds ?? [];
      productCache.set(cacheKey, {
        collectionIds,
        expiresAt: input.now.getTime() + PRODUCT_CACHE_MS,
      });
      return collectionIds;
    }),
  );
  return [...new Set(memberships.flat())];
}

function recipientDestination(
  recipient: RuleWithRecipients["recipients"][number]["recipient"],
  channel: Channel,
): string | null {
  switch (channel) {
    case Channel.EMAIL:
      return recipient.email;
    case Channel.SLACK:
      return recipient.slackWebhookUrlEnc;
    case Channel.DISCORD:
      return recipient.discordWebhookUrlEnc;
    case Channel.SMS:
      return recipient.phoneE164;
  }
}

async function createAlerts(
  tx: TransactionClient,
  input: {
    event: ProcessableWebhookEvent;
    shopId: string;
    shopPlan: Plan;
    facts: TriggerFacts;
    rules: RuleWithRecipients[];
  },
): Promise<number> {
  let created = 0;
  const summary = orderSummary(input.facts);
  for (const rule of input.rules) {
    const alertId = randomUUID();
    const messageKey = dedupeKeyForRule(rule, input.facts);
    const result = await tx.alert.createMany({
      data: [
        {
          id: alertId,
          shopId: input.shopId,
          ruleId: rule.id,
          webhookEventId: input.event.id,
          dedupeKey: messageKey,
          orderId: summary.orderId,
          orderName: summary.orderName,
          orderValue: summary.orderValue,
          firedAt: input.event.receivedAt,
        },
      ],
      skipDuplicates: true,
    });
    if (result.count === 0) continue;

    const deliveries = rule.recipients.flatMap(({ recipient, channels }) =>
      channels.map((channel) => {
        const access = channelAccessForPlan(input.shopPlan, channel);
        const destination = recipientDestination(recipient, channel);
        const configured = Boolean(destination);
        return {
          alertId,
          recipientId: recipient.id,
          channel,
          messageKey,
          destination: destination ?? `unconfigured:${recipient.id}`,
          status:
            configured && access.allowed
              ? DeliveryStatus.PENDING
              : DeliveryStatus.SKIPPED,
          statusAt:
            configured && access.allowed ? null : input.event.receivedAt,
          lastError: !access.allowed
            ? access.reason
            : configured
              ? null
              : `Recipient has no ${channel.toLowerCase()} destination configured`,
        };
      }),
    );
    if (deliveries.length > 0) {
      await tx.delivery.createMany({ data: deliveries });
    }
    created += 1;
  }
  return created;
}

async function updateUsageCounter(
  tx: TransactionClient,
  event: ProcessableWebhookEvent,
  shopId: string,
): Promise<void> {
  if (event.topic !== SHOPIFY_TOPICS.ORDERS_CREATE) return;
  const year = event.receivedAt.getUTCFullYear();
  const month = event.receivedAt.getUTCMonth();
  const periodYYYYMM = `${year}-${String(month + 1).padStart(2, "0")}`;
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  const [row] = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(DISTINCT "orderId")::bigint AS count
    FROM "WebhookEvent"
    WHERE "shopDomain" = ${event.shopDomain}
      AND topic = ${SHOPIFY_TOPICS.ORDERS_CREATE}
      AND "orderId" IS NOT NULL
      AND "receivedAt" >= ${start}
      AND "receivedAt" < ${end}
  `);
  await tx.usageCounter.upsert({
    where: { shopId_periodYYYYMM: { shopId, periodYYYYMM } },
    update: { ordersProcessed: Number(row?.count ?? 0) },
    create: { shopId, periodYYYYMM, ordersProcessed: Number(row?.count ?? 0) },
  });
}

async function processInventoryFacts(input: {
  client: PrismaClient;
  event: ProcessableWebhookEvent;
  facts: InventoryFacts;
  shopId: string;
  shopPlan: Plan;
  rules: RuleWithRecipients[];
}): Promise<void> {
  await input.client.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${`${input.shopId}:${input.facts.inventoryItemId}:${input.facts.locationId}`})
      )
    `);
    const state = await tx.inventoryState.findUnique({
      where: {
        shopId_inventoryItemId_locationId: {
          shopId: input.shopId,
          inventoryItemId: input.facts.inventoryItemId,
          locationId: input.facts.locationId,
        },
      },
    });
    if (!state) {
      await tx.inventoryState.create({
        data: {
          shopId: input.shopId,
          inventoryItemId: input.facts.inventoryItemId,
          locationId: input.facts.locationId,
          lastAvailable: input.facts.available,
        },
      });
      return;
    }

    const lowStockRules = input.rules.filter(
      (rule) => rule.trigger === Trigger.LOW_STOCK,
    );
    const recovered = lowStockRules.some((rule) => {
      const conditions = rule.conditions as { stockThreshold?: unknown };
      const threshold = Number(conditions.stockThreshold);
      return (
        Number.isInteger(threshold) &&
        state.lastAvailable <= threshold &&
        input.facts.available > threshold
      );
    });
    const epoch = state.epoch + (recovered ? 1 : 0);
    const facts: InventoryFacts = {
      ...input.facts,
      previousAvailable: state.lastAvailable,
      epoch,
    };
    const matched = evaluateAll(facts, input.rules);
    await tx.inventoryState.update({
      where: {
        shopId_inventoryItemId_locationId: {
          shopId: input.shopId,
          inventoryItemId: input.facts.inventoryItemId,
          locationId: input.facts.locationId,
        },
      },
      data: { lastAvailable: input.facts.available, epoch },
    });
    await createAlerts(tx, {
      event: input.event,
      shopId: input.shopId,
      shopPlan: input.shopPlan,
      facts,
      rules: matched,
    });
  });
}

export async function processRulesForEvent(
  event: ProcessableWebhookEvent,
  context: { prisma: PrismaClient },
  dependencies: { shopifyAdmin?: ShopifyAdmin; now?: Date } = {},
): Promise<void> {
  if (
    typeof event.payload !== "object" ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    throw new Error(`Webhook ${event.id} has no processable payload`);
  }
  const initialFacts = extractTriggerFacts(
    event.topic,
    event.payload as Record<string, unknown>,
  );
  if (!initialFacts) return;

  const shop = await context.prisma.shop.findUnique({
    where: { shopDomain: event.shopDomain },
    include: {
      rules: {
        where: { enabled: true },
        include: { recipients: { include: { recipient: true } } },
      },
    },
  });
  if (!shop) throw new Error(`Unknown shop ${event.shopDomain}`);

  if (initialFacts.topic === SHOPIFY_TOPICS.INVENTORY_LEVELS_UPDATE) {
    await processInventoryFacts({
      client: context.prisma,
      event,
      facts: initialFacts,
      shopId: shop.id,
      shopPlan: shop.plan,
      rules: shop.rules,
    });
    return;
  }

  let facts: TriggerFacts = initialFacts;
  if (
    facts.topic === SHOPIFY_TOPICS.ORDERS_CREATE &&
    shop.rules.some((rule) => {
      const conditions = rule.conditions as { collectionIds?: unknown };
      return (
        rule.trigger === Trigger.PRODUCT_ORDERED &&
        Array.isArray(conditions.collectionIds) &&
        conditions.collectionIds.length > 0
      );
    })
  ) {
    const shopifyAdmin =
      dependencies.shopifyAdmin ?? createAdapters().shopifyAdmin;
    const orderFacts = facts as OrderFacts;
    facts = {
      ...orderFacts,
      lineItemCollectionIds: await collectionIdsForProducts({
        shopDomain: event.shopDomain,
        productIds: orderFacts.lineItemProductIds,
        shopifyAdmin,
        now: dependencies.now ?? new Date(),
      }),
    };
  }

  const matched = evaluateAll(facts, shop.rules);
  await context.prisma.$transaction(async (tx) => {
    await createAlerts(tx, {
      event,
      shopId: shop.id,
      shopPlan: shop.plan,
      facts,
      rules: matched,
    });
    await updateUsageCounter(tx, event, shop.id);
  });
}

let registered = false;

export function registerRuleTopicHandlers(): void {
  if (registered) return;
  const handler: TopicHandler = processRulesForEvent;
  for (const topic of [
    SHOPIFY_TOPICS.ORDERS_CREATE,
    SHOPIFY_TOPICS.ORDERS_PAID,
    SHOPIFY_TOPICS.REFUNDS_CREATE,
    SHOPIFY_TOPICS.INVENTORY_LEVELS_UPDATE,
    SHOPIFY_TOPICS.ORDER_TRANSACTIONS_CREATE,
  ]) {
    registerTopicHandler(topic, handler);
  }
  registered = true;
}
