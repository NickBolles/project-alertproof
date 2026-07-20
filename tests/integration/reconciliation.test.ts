import {
  DeliveryStatus,
  EventSource,
  EventStatus,
  Trigger,
} from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../app/db.server";
import { createAdapters } from "../../app/lib/adapters/index.server";
import { FakeClock } from "../../app/lib/adapters/clock/fake.server";
import { MockShopifyAdmin } from "../../app/lib/adapters/shopify-admin/mock.server";
import { AlertDispatcher } from "../../app/lib/delivery/dispatch.server";
import { PrismaDeliveryLogStore } from "../../app/lib/delivery/log.server";
import { parseEnv } from "../../app/lib/env.server";
import { enqueueWebhook } from "../../app/lib/ingest/enqueue.server";
import { processPending } from "../../app/lib/ingest/processor.server";
import { SHOPIFY_TOPICS } from "../../app/lib/ingest/topics";
import type { ShopifyOrder } from "../../app/lib/ports";
import { reconcileShop } from "../../app/lib/reconcile/reconcile.server";
import { pruneExpiredDetail } from "../../app/lib/retention/prune.server";
import { processRulesForEvent } from "../../app/lib/rules/handlers.server";
import {
  buildOrderWriteback,
  processPendingWritebacks,
} from "../../app/lib/writeback/order.server";
import { action as cronAction } from "../../app/routes/internal.cron.$job";
import { validEnv } from "../helpers/env";
import { MemoryOutbox } from "../helpers/memory";

const integration = describe.skipIf(!process.env.TEST_DATABASE_URL);
const shopDomain = "phase4-fixture.myshopify.com";
const installedAt = new Date("2026-07-20T12:00:00.000Z");

function order(input: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    id: "4001",
    name: "#4001",
    createdAt: installedAt,
    updatedAt: new Date("2026-07-20T12:05:00.000Z"),
    financialStatus: "paid",
    totalPrice: "250.00",
    refunds: [],
    lineItems: [{ productId: "product-1", title: "Widget" }],
    ...input,
  };
}

async function createRule(trigger: Trigger, id: string) {
  await prisma.rule.create({
    data: {
      id,
      shopId: "phase4-shop",
      name: id,
      trigger,
      recipients: {
        create: { recipientId: "phase4-recipient", channels: ["EMAIL"] },
      },
    },
  });
}

integration("reconciliation, writeback, and durable dedupe retention", () => {
  beforeEach(async () => {
    await prisma.providerEvent.deleteMany();
    await prisma.shop.deleteMany({ where: { shopDomain } });
    await prisma.shop.create({
      data: {
        id: "phase4-shop",
        shopDomain,
        installedAt,
        reconcileCursor: installedAt,
      },
    });
    await prisma.recipient.create({
      data: {
        id: "phase4-recipient",
        shopId: "phase4-shop",
        name: "Ops",
        email: "mock://ops",
      },
    });
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { shopDomain } });
    await prisma.$disconnect();
  });

  it("recovers a dropped paid webhook through the identical pipeline and sends exactly once", async () => {
    await createRule(Trigger.ORDER_PAID, "paid-rule");
    await enqueueWebhook(
      {
        shopDomain,
        topic: SHOPIFY_TOPICS.ORDERS_CREATE,
        shopifyWebhookId: "real:create:4001",
        payload: { id: 4001, name: "#4001" },
        receivedAt: installedAt,
      },
      prisma,
    );
    await prisma.webhookEvent.update({
      where: { shopifyWebhookId: "real:create:4001" },
      data: { status: EventStatus.PROCESSED, processedAt: installedAt },
    });
    const admin = new MockShopifyAdmin({ orders: { [shopDomain]: [order()] } });
    const clock = new FakeClock(new Date("2026-07-20T12:15:00.000Z"));

    expect(
      await reconcileShop({
        shopId: "phase4-shop",
        shopifyAdmin: admin,
        client: prisma,
        clock,
      }),
    ).toEqual({ ordersChecked: 1, missedFound: 1 });
    expect(
      await prisma.webhookEvent.findMany({
        where: { shopDomain, source: EventSource.RECONCILIATION },
        select: {
          topic: true,
          orderId: true,
          resourceId: true,
          shopifyWebhookId: true,
        },
      }),
    ).toEqual([
      {
        topic: "orders/paid",
        orderId: "4001",
        resourceId: "4001",
        shopifyWebhookId: `${"recon:"}${shopDomain}:orders/paid:4001`,
      },
    ]);

    await processPending({
      client: prisma,
      now: clock.now(),
      topicHandlers: new Map([
        [
          "orders/paid",
          (event, context) =>
            processRulesForEvent(event, context, { now: clock.now() }),
        ],
      ]),
    });
    const outbox = new MemoryOutbox();
    const adapters = createAdapters(
      parseEnv({ ...validEnv, ALERTPROOF_FORCE_MOCKS: "1" }),
      { outbox, clock },
    );
    await new AlertDispatcher(
      new PrismaDeliveryLogStore(prisma),
      prisma,
      adapters,
      clock,
    ).dispatch();
    expect(outbox.records).toHaveLength(1);
    expect(await prisma.alert.count({ where: { shopId: "phase4-shop" } })).toBe(
      1,
    );

    clock.set(new Date("2026-07-20T12:30:00.000Z"));
    expect(
      await reconcileShop({
        shopId: "phase4-shop",
        shopifyAdmin: admin,
        client: prisma,
        clock,
      }),
    ).toEqual({ ordersChecked: 0, missedFound: 0 });
    await processPending({ client: prisma, now: clock.now() });
    await new AlertDispatcher(
      new PrismaDeliveryLogStore(prisma),
      prisma,
      adapters,
      clock,
    ).dispatch();
    expect(outbox.records).toHaveLength(1);
    expect(await prisma.alert.count({ where: { shopId: "phase4-shop" } })).toBe(
      1,
    );
  });

  it("derives per-topic/refund expectations and adds only a new second refund", async () => {
    const first = {
      id: "refund-1",
      createdAt: new Date("2026-07-20T12:05:00Z"),
    };
    const second = {
      id: "refund-2",
      createdAt: new Date("2026-07-20T12:20:00Z"),
    };
    const admin = new MockShopifyAdmin({
      orders: { [shopDomain]: [order({ refunds: [first] })] },
    });
    const clock = new FakeClock(new Date("2026-07-20T12:15:00Z"));
    expect(
      await reconcileShop({
        shopId: "phase4-shop",
        shopifyAdmin: admin,
        client: prisma,
        clock,
      }),
    ).toEqual({ ordersChecked: 1, missedFound: 3 });
    admin.seedOrders(shopDomain, [
      order({
        updatedAt: new Date("2026-07-20T12:20:00Z"),
        refunds: [first, second],
      }),
    ]);
    clock.set(new Date("2026-07-20T12:30:00Z"));
    expect(
      await reconcileShop({
        shopId: "phase4-shop",
        shopifyAdmin: admin,
        client: prisma,
        clock,
      }),
    ).toEqual({ ordersChecked: 1, missedFound: 1 });
    expect(
      await prisma.webhookEvent.findMany({
        where: { shopDomain, topic: "refunds/create" },
        orderBy: { resourceId: "asc" },
        select: { resourceId: true, shopifyWebhookId: true },
      }),
    ).toEqual([
      {
        resourceId: "refund-1",
        shopifyWebhookId: `recon:${shopDomain}:refunds/create:refund-1`,
      },
      {
        resourceId: "refund-2",
        shopifyWebhookId: `recon:${shopDomain}:refunds/create:refund-2`,
      },
    ]);
  });

  it("skips pre-install orders, uses the overlap, and leaves cursor unchanged on failure", async () => {
    const admin = new MockShopifyAdmin({
      orders: {
        [shopDomain]: [
          order({
            id: "old-order",
            createdAt: new Date(installedAt.getTime() - 1),
            updatedAt: new Date("2026-07-20T12:10:00Z"),
          }),
        ],
      },
    });
    const clock = new FakeClock(new Date("2026-07-20T12:15:00Z"));
    expect(
      await reconcileShop({
        shopId: "phase4-shop",
        shopifyAdmin: admin,
        client: prisma,
        clock,
      }),
    ).toEqual({ ordersChecked: 0, missedFound: 0 });
    expect(admin.orderQueries[0].updatedSince).toEqual(
      new Date(installedAt.getTime() - 5 * 60_000),
    );
    const cursor = (
      await prisma.shop.findUniqueOrThrow({ where: { id: "phase4-shop" } })
    ).reconcileCursor!;
    const failing = new MockShopifyAdmin();
    failing.getOrdersUpdatedSince = async () =>
      Promise.reject(new Error("Admin API down"));
    clock.set(new Date("2026-07-20T12:30:00Z"));
    await expect(
      reconcileShop({
        shopId: "phase4-shop",
        shopifyAdmin: failing,
        client: prisma,
        clock,
      }),
    ).rejects.toThrow("Admin API down");
    expect(
      (await prisma.shop.findUniqueOrThrow({ where: { id: "phase4-shop" } }))
        .reconcileCursor,
    ).toEqual(cursor);
  });

  it("writes deterministic metafield/note summaries and retries independently", async () => {
    const alert = await prisma.alert.create({
      data: {
        id: "writeback-alert",
        shopId: "phase4-shop",
        dedupeKey: "writeback-message",
        orderId: "4001",
        orderName: "#4001",
        writebackNextAt: installedAt,
      },
    });
    await prisma.delivery.create({
      data: {
        alertId: alert.id,
        recipientId: "phase4-recipient",
        messageKey: alert.dedupeKey,
        destination: "mock://ops",
        channel: "EMAIL",
        status: DeliveryStatus.DELIVERED,
      },
    });
    const clock = new FakeClock(new Date("2026-07-20T12:15:00Z"));
    const admin = new MockShopifyAdmin();
    let failures = 1;
    const original = admin.writeOrderMetafield.bind(admin);
    admin.writeOrderMetafield = async (input) => {
      if (failures-- > 0) throw new Error("writeback unavailable");
      return original(input);
    };
    expect(
      await processPendingWritebacks({
        shopifyAdmin: admin,
        client: prisma,
        clock,
      }),
    ).toEqual({ processed: 0, failed: 1, deferred: 0 });
    clock.set(new Date("2026-07-20T12:15:30Z"));
    expect(
      await processPendingWritebacks({
        shopifyAdmin: admin,
        client: prisma,
        clock,
      }),
    ).toEqual({ processed: 1, failed: 0, deferred: 0 });
    expect(admin.metafieldWrites).toHaveLength(1);
    expect(admin.noteWrites).toHaveLength(1);
    expect(admin.metafieldWrites[0]).toMatchObject({
      namespace: "alertproof",
      key: "status",
      value: JSON.stringify({
        alerts: 1,
        delivered: 1,
        bounced: 0,
        lastUpdate: clock.now().toISOString(),
      }),
    });
    expect(admin.noteWrites[0].note).toBe(
      "AlertProof: 1/1 deliveries delivered (email x1)",
    );
    const full = await prisma.alert.findUniqueOrThrow({
      where: { id: alert.id },
      include: { deliveries: true },
    });
    expect(buildOrderWriteback([full], clock.now())).toMatchSnapshot();
  });

  it("prunes details but keeps Alert and indexed event identity forever", async () => {
    const event = await prisma.webhookEvent.create({
      data: {
        shopDomain,
        topic: "orders/create",
        shopifyWebhookId: "retention-event",
        source: EventSource.WEBHOOK,
        orderId: "retention-order",
        resourceId: "retention-order",
        payload: { id: "retention-order" },
        receivedAt: installedAt,
      },
    });
    const alert = await prisma.alert.create({
      data: {
        id: "retention-alert",
        shopId: "phase4-shop",
        webhookEventId: event.id,
        dedupeKey: "retention-dedupe",
        orderId: "retention-order",
        createdAt: installedAt,
      },
    });
    await prisma.delivery.create({
      data: {
        alertId: alert.id,
        recipientId: "phase4-recipient",
        messageKey: alert.dedupeKey,
        destination: "mock://retention",
        channel: "EMAIL",
        createdAt: installedAt,
      },
    });
    await prisma.providerEvent.create({
      data: {
        provider: "mock",
        providerMessageId: "retention-message",
        type: "delivered",
        payload: {},
        receivedAt: installedAt,
      },
    });
    await pruneExpiredDetail({
      client: prisma,
      cutoff: new Date(installedAt.getTime() + 1),
    });
    expect(
      await prisma.alert.findUnique({ where: { id: alert.id } }),
    ).toMatchObject({
      dedupeKey: "retention-dedupe",
      orderId: "retention-order",
    });
    expect(await prisma.delivery.count({ where: { alertId: alert.id } })).toBe(
      0,
    );
    expect(
      await prisma.webhookEvent.findUnique({ where: { id: event.id } }),
    ).toMatchObject({
      payload: null,
      orderId: "retention-order",
      resourceId: "retention-order",
    });
  });

  it("rejects the reconciliation cron without its bearer secret", async () => {
    const response = await cronAction({
      request: new Request("http://localhost/internal/cron/reconcile", {
        method: "POST",
      }),
      params: { job: "reconcile" },
      context: {},
    } as never);
    expect(response.status).toBe(401);
  });
});
