import {
  Channel,
  DeliveryStatus,
  EventStatus,
  Prisma,
  Trigger,
  type Recipient,
} from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../app/db.server";
import { MockShopifyAdmin } from "../../app/lib/adapters/shopify-admin/mock.server";
import { enqueueWebhook } from "../../app/lib/ingest/enqueue.server";
import {
  processPending,
  type TopicHandler,
} from "../../app/lib/ingest/processor.server";
import {
  clearProductCollectionCache,
  processRulesForEvent,
} from "../../app/lib/rules/handlers.server";
import failedTransaction from "../fixtures/failed-transaction.json";
import highValueOrder from "../fixtures/order-high-value-product.json";
import inventoryLevel from "../fixtures/inventory-level.json";
import normalOrder from "../fixtures/order-normal.json";
import paidOrder from "../fixtures/order-paid.json";
import refund from "../fixtures/refund.json";

const integration = describe.skipIf(!process.env.TEST_DATABASE_URL);
const shopDomain = "phase2-fixture.myshopify.com";
const shopId = "phase2-shop";
const baseTime = new Date("2026-07-20T12:00:00.000Z");

integration("rules persistence pipeline", () => {
  let recipient: Recipient;
  let shopifyAdmin: MockShopifyAdmin;
  let handler: TopicHandler;

  async function cleanFixtureShop() {
    await prisma.delivery.deleteMany({ where: { alert: { shopId } } });
    await prisma.shop.deleteMany({ where: { shopDomain } });
  }

  beforeEach(async () => {
    await cleanFixtureShop();
    await prisma.shop.create({
      data: {
        id: shopId,
        shopDomain,
        installedAt: baseTime,
        trialEndsAt: new Date("2026-08-03T12:00:00.000Z"),
        reconcileCursor: baseTime,
      },
    });
    recipient = await prisma.recipient.create({
      data: {
        id: "phase2-recipient",
        shopId,
        name: "Owner",
        email: "owner@example.test",
        slackWebhookUrlEnc: "encrypted-slack",
      },
    });
    shopifyAdmin = new MockShopifyAdmin();
    shopifyAdmin.seedProduct({
      id: "2002",
      title: "Equipment",
      collectionIds: ["collection-ops"],
    });
    clearProductCollectionCache();
    handler = (event, context) =>
      processRulesForEvent(event, context, { shopifyAdmin, now: baseTime });
  });

  afterAll(async () => {
    await cleanFixtureShop();
    await prisma.$disconnect();
  });

  async function createRule(input: {
    id: string;
    trigger: Trigger;
    conditions?: Prisma.InputJsonObject;
    channels?: Channel[];
    recipientId?: string;
  }) {
    return prisma.rule.create({
      data: {
        id: input.id,
        shopId,
        name: input.id,
        trigger: input.trigger,
        conditions: input.conditions ?? {},
        recipients: {
          create: {
            recipientId: input.recipientId ?? recipient.id,
            channels: input.channels ?? [Channel.EMAIL],
          },
        },
      },
    });
  }

  async function enqueueAndProcess(input: {
    topic: string;
    webhookId: string;
    payload: Record<string, unknown>;
    at?: Date;
  }) {
    const at = input.at ?? baseTime;
    await enqueueWebhook(
      {
        shopDomain,
        topic: input.topic,
        shopifyWebhookId: input.webhookId,
        payload: input.payload,
        receivedAt: at,
      },
      prisma,
    );
    return processPending({
      client: prisma,
      now: at,
      topicHandlers: new Map([[input.topic, handler]]),
    });
  }

  it("creates idempotent Alerts plus PENDING deliveries for direct and collection matches", async () => {
    await createRule({ id: "created", trigger: Trigger.ORDER_CREATED });
    await createRule({
      id: "value",
      trigger: Trigger.ORDER_VALUE_GTE,
      conditions: { minValue: "500.00" },
    });
    await createRule({
      id: "product",
      trigger: Trigger.PRODUCT_ORDERED,
      conditions: { productIds: ["2002"] },
    });
    await createRule({
      id: "collection",
      trigger: Trigger.PRODUCT_ORDERED,
      conditions: { collectionIds: ["collection-ops"] },
    });

    expect(
      await enqueueAndProcess({
        topic: "orders/create",
        webhookId: "big-order",
        payload: highValueOrder,
      }),
    ).toMatchObject({ processed: 1, failed: 0 });
    expect(await prisma.alert.count({ where: { shopId } })).toBe(4);
    expect(
      await prisma.delivery.count({
        where: { alert: { shopId }, status: DeliveryStatus.PENDING },
      }),
    ).toBe(4);

    const event = await prisma.webhookEvent.findUniqueOrThrow({
      where: { shopifyWebhookId: "big-order" },
    });
    await processRulesForEvent(
      event,
      { prisma },
      { shopifyAdmin, now: baseTime },
    );
    expect(await prisma.alert.count({ where: { shopId } })).toBe(4);
    expect(await prisma.delivery.count({ where: { alert: { shopId } } })).toBe(
      4,
    );
    expect(
      await prisma.usageCounter.findUnique({
        where: { shopId_periodYYYYMM: { shopId, periodYYYYMM: "2026-07" } },
      }),
    ).toMatchObject({ ordersProcessed: 1 });
  });

  it("creates SKIPPED deliveries with a reason when channel data is absent", async () => {
    const emptyRecipient = await prisma.recipient.create({
      data: { id: "empty-recipient", shopId, name: "No destinations" },
    });
    await createRule({
      id: "missing-email",
      trigger: Trigger.ORDER_CREATED,
      channels: [Channel.EMAIL],
      recipientId: emptyRecipient.id,
    });
    await enqueueAndProcess({
      topic: "orders/create",
      webhookId: "missing-destination",
      payload: normalOrder,
    });
    expect(
      await prisma.delivery.findFirstOrThrow({
        where: { alert: { shopId } },
        select: { status: true, lastError: true },
      }),
    ).toEqual({
      status: DeliveryStatus.SKIPPED,
      lastError: "Recipient has no email destination configured",
    });
  });

  it("keeps paid/create out-of-order events independent and filters successful payments", async () => {
    await createRule({ id: "paid", trigger: Trigger.ORDER_PAID });
    await createRule({ id: "created", trigger: Trigger.ORDER_CREATED });
    await createRule({ id: "payment-failed", trigger: Trigger.PAYMENT_FAILED });
    await enqueueAndProcess({
      topic: "orders/paid",
      webhookId: "paid-before-create",
      payload: paidOrder,
    });
    await enqueueAndProcess({
      topic: "orders/create",
      webhookId: "create-after-paid",
      payload: normalOrder,
      at: new Date(baseTime.getTime() + 1),
    });
    await enqueueAndProcess({
      topic: "order_transactions/create",
      webhookId: "failed-payment",
      payload: failedTransaction,
      at: new Date(baseTime.getTime() + 2),
    });
    await enqueueAndProcess({
      topic: "order_transactions/create",
      webhookId: "successful-payment",
      payload: { ...failedTransaction, id: 6002, status: "success" },
      at: new Date(baseTime.getTime() + 3),
    });

    expect(
      await prisma.alert.findMany({
        where: { shopId },
        orderBy: { dedupeKey: "asc" },
        select: { dedupeKey: true },
      }),
    ).toEqual([
      { dedupeKey: "created:orders/create:1001" },
      { dedupeKey: "paid:orders/paid:1002" },
      {
        dedupeKey: "payment-failed:order_transactions/create:6001",
      },
    ]);
  });

  it("creates two alerts for two partial refunds on one order", async () => {
    await createRule({ id: "refund", trigger: Trigger.REFUND_CREATED });
    await enqueueAndProcess({
      topic: "refunds/create",
      webhookId: "refund-delivery-1",
      payload: refund,
    });
    await enqueueAndProcess({
      topic: "refunds/create",
      webhookId: "refund-delivery-2",
      payload: { ...refund, id: 9002 },
      at: new Date(baseTime.getTime() + 1),
    });

    expect(
      await prisma.alert.findMany({
        where: { shopId },
        orderBy: { dedupeKey: "asc" },
        select: { dedupeKey: true },
      }),
    ).toEqual([
      { dedupeKey: "refund:refunds/create:9001" },
      { dedupeKey: "refund:refunds/create:9002" },
    ]);
  });

  it("fires LOW_STOCK once per crossing and re-arms by incrementing epoch", async () => {
    await createRule({
      id: "low-stock",
      trigger: Trigger.LOW_STOCK,
      conditions: { stockThreshold: 5 },
    });
    const levels = [10, 5, 3, 6, 5];
    for (const [index, available] of levels.entries()) {
      await enqueueAndProcess({
        topic: "inventory_levels/update",
        webhookId: `inventory-${index}`,
        payload: { ...inventoryLevel, available },
        at: new Date(baseTime.getTime() + index),
      });
    }

    expect(
      await prisma.alert.findMany({
        where: { shopId },
        orderBy: { dedupeKey: "asc" },
        select: { dedupeKey: true },
      }),
    ).toEqual([
      { dedupeKey: "low-stock:low_stock:7001:8001:5:0" },
      { dedupeKey: "low-stock:low_stock:7001:8001:5:1" },
    ]);
    expect(
      await prisma.inventoryState.findUniqueOrThrow({
        where: {
          shopId_inventoryItemId_locationId: {
            shopId,
            inventoryItemId: "7001",
            locationId: "8001",
          },
        },
        select: { lastAvailable: true, epoch: true },
      }),
    ).toEqual({ lastAvailable: 5, epoch: 1 });
    expect(
      await prisma.webhookEvent.count({
        where: { shopDomain, status: EventStatus.PROCESSED },
      }),
    ).toBe(5);
  });
});
