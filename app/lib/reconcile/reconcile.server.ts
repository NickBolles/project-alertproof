import { EventSource, type PrismaClient } from "@prisma/client";
import prisma from "../../db.server";
import { createAdapters } from "../adapters/index.server";
import { enqueueWebhook } from "../ingest/enqueue.server";
import { expectedEventsForOrder } from "../ingest/topics";
import type { Clock, ShopifyAdmin, ShopifyOrder } from "../ports";

export const RECONCILE_OVERLAP_MS = 5 * 60_000;

// Shopify exposes current order/payment/refund state, so those missed topics
// are recoverable. It does not expose inventory-level history; LOW_STOCK stays
// webhook-only by design.

function orderWebhookPayload(order: ShopifyOrder): Record<string, unknown> {
  return {
    id: order.id,
    name: order.name,
    created_at: order.createdAt.toISOString(),
    updated_at: order.updatedAt.toISOString(),
    financial_status: order.financialStatus,
    total_price: order.totalPrice,
    line_items: order.lineItems.map((item) => ({
      product_id: item.productId,
      variant_id: item.variantId,
      title: item.title,
    })),
    refunds: order.refunds.map((refund) => ({
      id: refund.id,
      created_at: refund.createdAt.toISOString(),
    })),
  };
}

function eventPayload(
  order: ShopifyOrder,
  event: ReturnType<typeof expectedEventsForOrder>[number],
): Record<string, unknown> {
  if (event.topic !== "refunds/create") return orderWebhookPayload(order);
  const refund = order.refunds.find((item) => item.id === event.resourceId);
  if (!refund) throw new Error(`Expected refund ${event.resourceId} is absent`);
  return {
    id: refund.id,
    order_id: order.id,
    created_at: refund.createdAt.toISOString(),
  };
}

export async function reconcileShop(input: {
  shopId: string;
  shopifyAdmin: ShopifyAdmin;
  client?: PrismaClient;
  clock?: Clock;
}): Promise<{ ordersChecked: number; missedFound: number }> {
  const client = input.client ?? prisma;
  const runStartedAt = input.clock?.now() ?? new Date();
  const shop = await client.shop.findUniqueOrThrow({
    where: { id: input.shopId },
  });
  const cursor = shop.reconcileCursor ?? shop.installedAt;
  const run = await client.reconciliationRun.create({
    data: { shopId: shop.id, startedAt: runStartedAt, cursor },
  });
  let ordersChecked = 0;
  let missedFound = 0;

  try {
    let pageCursor: string | undefined;
    do {
      const page = await input.shopifyAdmin.getOrdersUpdatedSince({
        shopDomain: shop.shopDomain,
        updatedSince: new Date(cursor.getTime() - RECONCILE_OVERLAP_MS),
        cursor: pageCursor,
        limit: 50,
      });
      for (const order of page.orders) {
        if (order.createdAt < shop.installedAt) continue;
        ordersChecked += 1;
        for (const expected of expectedEventsForOrder(shop.shopDomain, order)) {
          const exists = await client.webhookEvent.findFirst({
            where: {
              shopDomain: shop.shopDomain,
              topic: expected.topic,
              orderId: expected.orderId,
              resourceId: expected.resourceId,
            },
            select: { id: true },
          });
          if (exists) continue;
          const inserted = await enqueueWebhook(
            {
              shopDomain: shop.shopDomain,
              topic: expected.topic,
              shopifyWebhookId: expected.syntheticWebhookId,
              source: EventSource.RECONCILIATION,
              payload: eventPayload(order, expected),
              receivedAt: runStartedAt,
            },
            client,
          );
          if (inserted.inserted) missedFound += 1;
        }
      }
      pageCursor = page.nextCursor;
    } while (pageCursor);

    await client.$transaction([
      client.reconciliationRun.update({
        where: { id: run.id },
        data: { finishedAt: runStartedAt, ordersChecked, missedFound },
      }),
      client.shop.update({
        where: { id: shop.id },
        data: { reconcileCursor: runStartedAt },
      }),
    ]);
    return { ordersChecked, missedFound };
  } catch (error) {
    await client.reconciliationRun.update({
      where: { id: run.id },
      data: {
        finishedAt: runStartedAt,
        ordersChecked,
        missedFound,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export async function reconcileAllShops(
  input: {
    shopifyAdmin?: ShopifyAdmin;
    client?: PrismaClient;
    clock?: Clock;
  } = {},
) {
  const client = input.client ?? prisma;
  const adapters = createAdapters();
  const shopifyAdmin = input.shopifyAdmin ?? adapters.shopifyAdmin;
  const shops = await client.shop.findMany({
    where: { uninstalledAt: null },
    select: { id: true },
  });
  const results = [];
  for (const shop of shops) {
    results.push({
      shopId: shop.id,
      ...(await reconcileShop({
        shopId: shop.id,
        shopifyAdmin,
        client,
        clock: input.clock,
      })),
    });
  }
  return results;
}
