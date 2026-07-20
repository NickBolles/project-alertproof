import { Prisma, type PrismaClient } from "@prisma/client";
import prisma from "../../db.server";
import { logger } from "../logger.server";
import {
  registerTopicHandler,
  type ProcessableWebhookEvent,
  type TopicHandler,
} from "../ingest/processor.server";
import { SHOPIFY_TOPICS } from "../ingest/topics";

function objectPayload(
  event: ProcessableWebhookEvent,
): Record<string, unknown> {
  if (
    !event.payload ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload)
  ) {
    throw new Error(`Compliance webhook ${event.id} has no object payload`);
  }
  return event.payload as Record<string, unknown>;
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string | number =>
          ["string", "number"].includes(typeof item),
        )
        .map(String)
    : [];
}

function orderWhere(orderIds: string[]) {
  return {
    OR: orderIds.flatMap((id) => [
      { orderId: id },
      { orderId: { endsWith: `/Order/${id}` } },
    ]),
  };
}

export async function handleCustomersDataRequest(
  event: ProcessableWebhookEvent,
  context: { prisma: PrismaClient },
): Promise<void> {
  const payload = objectPayload(event);
  const orderIds = stringIds(payload.orders_requested);
  const shop = await context.prisma.shop.findUnique({
    where: { shopDomain: event.shopDomain },
    select: { id: true },
  });
  const alerts =
    shop && orderIds.length
      ? await context.prisma.alert.findMany({
          where: { shopId: shop.id, ...orderWhere(orderIds) },
          select: {
            orderId: true,
            orderName: true,
            orderValue: true,
            firedAt: true,
          },
          orderBy: { firedAt: "asc" },
        })
      : [];
  await context.prisma.providerEvent.create({
    data: {
      provider: "shopify-gdpr",
      providerMessageId: event.shopDomain,
      type: `customers/data_request:${event.shopifyWebhookId}`,
      receivedAt: event.receivedAt,
      processedAt: new Date(),
      payload: {
        shopDomain: event.shopDomain,
        customerId:
          typeof (payload.customer as { id?: unknown } | undefined)?.id ===
            "number" ||
          typeof (payload.customer as { id?: unknown } | undefined)?.id ===
            "string"
            ? String((payload.customer as { id: string | number }).id)
            : null,
        requestedOrderIds: orderIds,
        storedData: alerts.map((alert) => ({
          orderId: alert.orderId,
          orderName: alert.orderName,
          orderValue: alert.orderValue?.toString() ?? null,
          alertedAt: alert.firedAt.toISOString(),
        })),
      },
    },
  });
  logger.info("gdpr.customer_data_compiled", {
    eventId: event.id,
    webhookId: event.shopifyWebhookId,
    records: alerts.length,
  });
}

export async function handleCustomersRedact(
  event: ProcessableWebhookEvent,
  context: { prisma: PrismaClient },
): Promise<void> {
  const payload = objectPayload(event);
  const orderIds = stringIds(payload.orders_to_redact);
  const shop = await context.prisma.shop.findUnique({
    where: { shopDomain: event.shopDomain },
    select: { id: true },
  });
  if (!shop) return;
  await context.prisma.$transaction(async (tx) => {
    if (orderIds.length) {
      await tx.alert.updateMany({
        where: { shopId: shop.id, ...orderWhere(orderIds) },
        data: { orderId: null, orderName: null, orderValue: null },
      });
      await tx.webhookEvent.updateMany({
        where: { shopDomain: event.shopDomain, ...orderWhere(orderIds) },
        data: { orderId: null, resourceId: null, payload: Prisma.DbNull },
      });
    }
    await tx.providerEvent.deleteMany({
      where: { provider: "shopify-gdpr", providerMessageId: event.shopDomain },
    });
  });
  logger.info("gdpr.customer_redacted", {
    eventId: event.id,
    webhookId: event.shopifyWebhookId,
    orders: orderIds.length,
  });
}

export async function handleShopRedact(
  event: ProcessableWebhookEvent,
  context: { prisma: PrismaClient },
): Promise<void> {
  const shop = await context.prisma.shop.findUnique({
    where: { shopDomain: event.shopDomain },
    select: { id: true },
  });
  if (!shop) return;
  const deliveries = await context.prisma.delivery.findMany({
    where: { alert: { shopId: shop.id } },
    select: { id: true, providerMessageId: true },
  });
  const deliveryIds = deliveries.map((delivery) => delivery.id);
  const providerMessageIds = deliveries
    .map((delivery) => delivery.providerMessageId)
    .filter((id): id is string => Boolean(id));
  await context.prisma.$transaction(async (tx) => {
    if (providerMessageIds.length) {
      await tx.providerEvent.deleteMany({
        where: { providerMessageId: { in: providerMessageIds } },
      });
    }
    await tx.providerEvent.deleteMany({
      where: { provider: "shopify-gdpr", providerMessageId: event.shopDomain },
    });
    if (deliveryIds.length) {
      await tx.mockOutbox.deleteMany({
        where: { deliveryId: { in: deliveryIds } },
      });
    }
    await tx.session.deleteMany({ where: { shop: event.shopDomain } });
    await tx.shop.delete({ where: { id: shop.id } });
  });
  logger.info("gdpr.shop_redacted", {
    eventId: event.id,
    webhookId: event.shopifyWebhookId,
  });
}

let registered = false;

export function registerComplianceTopicHandlers(): void {
  if (registered) return;
  const handlers: Array<[string, TopicHandler]> = [
    [SHOPIFY_TOPICS.CUSTOMERS_DATA_REQUEST, handleCustomersDataRequest],
    [SHOPIFY_TOPICS.CUSTOMERS_REDACT, handleCustomersRedact],
    [SHOPIFY_TOPICS.SHOP_REDACT, handleShopRedact],
  ];
  for (const [topic, handler] of handlers) registerTopicHandler(topic, handler);
  registered = true;
}

export async function processComplianceWebhookForTest(
  event: ProcessableWebhookEvent,
  client: PrismaClient = prisma,
): Promise<void> {
  const handlers: Record<string, TopicHandler> = {
    [SHOPIFY_TOPICS.CUSTOMERS_DATA_REQUEST]: handleCustomersDataRequest,
    [SHOPIFY_TOPICS.CUSTOMERS_REDACT]: handleCustomersRedact,
    [SHOPIFY_TOPICS.SHOP_REDACT]: handleShopRedact,
  };
  const handler = handlers[event.topic];
  if (!handler) throw new Error(`Unsupported compliance topic ${event.topic}`);
  await handler(event, { prisma: client });
}
