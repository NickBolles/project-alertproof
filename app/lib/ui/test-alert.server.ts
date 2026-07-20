import { EventSource, type PrismaClient } from "@prisma/client";
import prisma from "../../db.server";
import { createAdapters, type Adapters } from "../adapters/index.server";
import { AlertDispatcher } from "../delivery/dispatch.server";
import { PrismaDeliveryLogStore } from "../delivery/log.server";
import { enqueueWebhook } from "../ingest/enqueue.server";
import { processPending } from "../ingest/processor.server";
import { processRulesForEvent } from "../rules/handlers.server";

export async function runSyntheticTestAlert(input: {
  shopDomain: string;
  client?: PrismaClient;
  adapters?: Adapters;
  now?: Date;
}) {
  const client = input.client ?? prisma;
  const adapters = input.adapters ?? createAdapters();
  const now = input.now ?? adapters.clock.now();
  const suffix = `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  const orderId = `test-order-${suffix}`;
  const orderName = `#TEST-${now.getTime()}`;
  const webhookId = `test:orders/create:${suffix}`;
  await enqueueWebhook(
    {
      shopDomain: input.shopDomain,
      topic: "orders/create",
      shopifyWebhookId: webhookId,
      source: EventSource.TEST,
      receivedAt: now,
      payload: {
        id: orderId,
        name: orderName,
        total_price: "125.00",
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        line_items: [{ product_id: "test-product", title: "Test product" }],
      },
    },
    client,
  );
  await processPending({
    client,
    now,
    topicHandlers: new Map([
      [
        "orders/create",
        (event, context) =>
          processRulesForEvent(event, context, {
            shopifyAdmin: adapters.shopifyAdmin,
            now,
          }),
      ],
    ]),
  });
  await new AlertDispatcher(
    new PrismaDeliveryLogStore(client),
    client,
    adapters,
    adapters.clock,
  ).dispatch();
  return client.alert.findMany({
    where: { shop: { shopDomain: input.shopDomain }, orderId },
    include: { deliveries: { include: { recipient: true } }, rule: true },
  });
}
