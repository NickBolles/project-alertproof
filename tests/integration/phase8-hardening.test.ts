import {
  Channel,
  DeliveryStatus,
  EventStatus,
  Plan,
  Prisma,
  Trigger,
} from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../app/db.server";
import { processComplianceWebhookForTest } from "../../app/lib/compliance/gdpr.server";
import { getHealthSnapshot } from "../../app/lib/health.server";
import { runRetentionPrune } from "../../app/lib/retention/prune.server";
import { processRulesForEvent } from "../../app/lib/rules/handlers.server";

const integration = describe.skipIf(!process.env.TEST_DATABASE_URL);
const now = new Date("2026-07-20T12:00:00Z");
const day = 24 * 60 * 60_000;

integration("Phase 8 retention, GDPR, and health", () => {
  beforeEach(async () => {
    await prisma.shop.deleteMany({ where: { id: { startsWith: "phase8-" } } });
    await prisma.providerEvent.deleteMany({
      where: { providerMessageId: { startsWith: "phase8-" } },
    });
  });
  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { id: { startsWith: "phase8-" } } });
    await prisma.providerEvent.deleteMany({
      where: { providerMessageId: { startsWith: "phase8-" } },
    });
    await prisma.$disconnect();
  });

  async function seedRetentionShop(input: {
    id: string;
    plan: Plan;
    ageDays: number;
  }) {
    const createdAt = new Date(now.getTime() - input.ageDays * day);
    await prisma.shop.create({
      data: {
        id: input.id,
        shopDomain: `${input.id}.myshopify.com`,
        plan: input.plan,
        trialEndsAt: null,
      },
    });
    const recipient = await prisma.recipient.create({
      data: {
        id: `${input.id}-recipient`,
        shopId: input.id,
        name: "Owner",
        email: "owner@example.test",
      },
    });
    const rule = await prisma.rule.create({
      data: {
        id: `${input.id}-rule`,
        shopId: input.id,
        name: "Orders",
        trigger: Trigger.ORDER_CREATED,
        recipients: {
          create: { recipientId: recipient.id, channels: [Channel.EMAIL] },
        },
      },
    });
    const event = await prisma.webhookEvent.create({
      data: {
        id: `${input.id}-event`,
        shopDomain: `${input.id}.myshopify.com`,
        topic: "orders/create",
        shopifyWebhookId: `${input.id}-webhook`,
        orderId: "1001",
        resourceId: "1001",
        payload: {
          id: "1001",
          name: "#1001",
          total_price: "42.00",
          line_items: [],
        },
        status: EventStatus.PROCESSED,
        receivedAt: createdAt,
        processedAt: createdAt,
      },
    });
    const alert = await prisma.alert.create({
      data: {
        id: `${input.id}-alert`,
        shopId: input.id,
        ruleId: rule.id,
        webhookEventId: event.id,
        dedupeKey: `${rule.id}:orders/create:1001`,
        orderId: "1001",
        orderName: "#1001",
        orderValue: "42.00",
        firedAt: createdAt,
        writebackPending: false,
      },
    });
    const delivery = await prisma.delivery.create({
      data: {
        id: `${input.id}-delivery`,
        alertId: alert.id,
        recipientId: recipient.id,
        channel: Channel.EMAIL,
        messageKey: alert.dedupeKey,
        destination: recipient.email!,
        providerMessageId: `${input.id}-provider-message`,
        status: DeliveryStatus.DELIVERED,
        createdAt,
        sentAt: createdAt,
      },
    });
    await prisma.providerEvent.create({
      data: {
        provider: "postmark",
        providerMessageId: delivery.providerMessageId,
        type: "delivered",
        payload: { MessageID: delivery.providerMessageId },
        receivedAt: createdAt,
      },
    });
    return { rule, event, alert };
  }

  it("prunes 7d/90d detail, preserves Pro and every Alert dedupe row, and nulls payload only", async () => {
    await seedRetentionShop({
      id: "phase8-free",
      plan: Plan.FREE,
      ageDays: 10,
    });
    const standard = await seedRetentionShop({
      id: "phase8-standard",
      plan: Plan.STANDARD,
      ageDays: 100,
    });
    await seedRetentionShop({ id: "phase8-pro", plan: Plan.PRO, ageDays: 200 });
    await prisma.webhookEvent.create({
      data: {
        shopDomain: "phase8-free.myshopify.com",
        topic: "orders/create",
        shopifyWebhookId: "phase8-dead-webhook",
        status: EventStatus.DEAD,
        payload: { id: "dead" },
        receivedAt: new Date(now.getTime() - 100 * day),
      },
    });

    const result = await runRetentionPrune({
      client: prisma,
      now,
      batchSize: 2,
    });
    expect(result).toMatchObject({
      deliveries: 2,
      providerEvents: 2,
      deadEvents: 1,
    });
    expect(
      await prisma.alert.count({ where: { id: { startsWith: "phase8-" } } }),
    ).toBe(3);
    expect(
      await prisma.delivery.count({ where: { id: { startsWith: "phase8-" } } }),
    ).toBe(1);
    expect(
      await prisma.delivery.findUnique({
        where: { id: "phase8-pro-delivery" },
      }),
    ).not.toBeNull();
    expect(
      await prisma.alert.findUniqueOrThrow({
        where: { id: "phase8-free-alert" },
      }),
    ).toMatchObject({
      orderId: "1001",
      orderName: null,
      orderValue: null,
    });
    expect(
      await prisma.alert.findUniqueOrThrow({
        where: { id: "phase8-pro-alert" },
      }),
    ).toMatchObject({
      orderName: "#1001",
    });
    expect(
      await prisma.webhookEvent.findUniqueOrThrow({
        where: { id: standard.event.id },
      }),
    ).toMatchObject({
      orderId: "1001",
      payload: null,
    });

    const replay = await prisma.webhookEvent.create({
      data: {
        id: "phase8-standard-replay",
        shopDomain: "phase8-standard.myshopify.com",
        topic: "orders/create",
        shopifyWebhookId: "phase8-standard-replay-webhook",
        orderId: "1001",
        resourceId: "1001",
        payload: {
          id: "1001",
          name: "#1001",
          total_price: "42.00",
          line_items: [],
        },
        receivedAt: now,
      },
    });
    await processRulesForEvent(replay, { prisma }, { now });
    expect(
      await prisma.alert.count({ where: { shopId: "phase8-standard" } }),
    ).toBe(1);
  });

  it("compiles a customer data request and customer redaction scrubs stored order data", async () => {
    const seeded = await seedRetentionShop({
      id: "phase8-gdpr",
      plan: Plan.STANDARD,
      ageDays: 1,
    });
    const requestEvent = await prisma.webhookEvent.create({
      data: {
        shopDomain: "phase8-gdpr.myshopify.com",
        topic: "customers/data_request",
        shopifyWebhookId: "phase8-data-request",
        payload: { customer: { id: 77 }, orders_requested: [1001] },
        receivedAt: now,
      },
    });
    await processComplianceWebhookForTest(requestEvent, prisma);
    const audit = await prisma.providerEvent.findFirstOrThrow({
      where: { type: "customers/data_request:phase8-data-request" },
    });
    expect(audit.payload).toMatchObject({
      customerId: "77",
      requestedOrderIds: ["1001"],
      storedData: [expect.objectContaining({ orderName: "#1001" })],
    });

    const redactEvent = await prisma.webhookEvent.create({
      data: {
        shopDomain: "phase8-gdpr.myshopify.com",
        topic: "customers/redact",
        shopifyWebhookId: "phase8-customer-redact",
        payload: { customer: { id: 77 }, orders_to_redact: [1001] },
        receivedAt: now,
      },
    });
    await processComplianceWebhookForTest(redactEvent, prisma);
    expect(
      await prisma.alert.findUniqueOrThrow({ where: { id: seeded.alert.id } }),
    ).toMatchObject({
      orderId: null,
      orderName: null,
      orderValue: null,
    });
    expect(
      await prisma.webhookEvent.findUniqueOrThrow({
        where: { id: seeded.event.id },
      }),
    ).toMatchObject({
      orderId: null,
      resourceId: null,
      payload: null,
    });
    expect(
      await prisma.providerEvent.count({ where: { provider: "shopify-gdpr" } }),
    ).toBe(0);
  });

  it("shop redaction removes the shop, sessions, delivery audit, and mock outbox", async () => {
    await seedRetentionShop({
      id: "phase8-shop-redact",
      plan: Plan.PRO,
      ageDays: 1,
    });
    await prisma.session.create({
      data: {
        id: "phase8-session",
        shop: "phase8-shop-redact.myshopify.com",
        state: "state",
        isOnline: false,
        accessToken: "token",
      },
    });
    await prisma.mockOutbox.create({
      data: {
        channel: "email",
        to: "owner@example.test",
        payload: { subject: "alert" },
        deliveryId: "phase8-shop-redact-delivery",
      },
    });
    const event = await prisma.webhookEvent.create({
      data: {
        shopDomain: "phase8-shop-redact.myshopify.com",
        topic: "shop/redact",
        shopifyWebhookId: "phase8-shop-redact-request",
        payload: { shop_id: 123 },
        receivedAt: now,
      },
    });
    await processComplianceWebhookForTest(event, prisma);
    expect(
      await prisma.shop.findUnique({ where: { id: "phase8-shop-redact" } }),
    ).toBeNull();
    expect(
      await prisma.session.findUnique({ where: { id: "phase8-session" } }),
    ).toBeNull();
    expect(
      await prisma.mockOutbox.count({
        where: { deliveryId: "phase8-shop-redact-delivery" },
      }),
    ).toBe(0);
    expect(
      await prisma.providerEvent.count({
        where: { providerMessageId: "phase8-shop-redact-provider-message" },
      }),
    ).toBe(0);
  });

  it("healthz reports database state, queue depth, DEAD alarms, and oldest age", async () => {
    await prisma.shop.create({
      data: { id: "phase8-health", shopDomain: "phase8-health.myshopify.com" },
    });
    await prisma.webhookEvent.createMany({
      data: [
        {
          shopDomain: "phase8-health.myshopify.com",
          topic: "orders/create",
          shopifyWebhookId: "phase8-health-pending",
          status: EventStatus.PENDING,
          payload: Prisma.DbNull,
          receivedAt: new Date(now.getTime() - 300_000),
        },
        {
          shopDomain: "phase8-health.myshopify.com",
          topic: "orders/create",
          shopifyWebhookId: "phase8-health-dead",
          status: EventStatus.DEAD,
          payload: Prisma.DbNull,
          receivedAt: now,
        },
      ],
    });
    expect(await getHealthSnapshot(prisma, now)).toEqual({
      ok: false,
      database: { ok: true },
      queue: { depth: 1, dead: 1, oldestPendingAgeSeconds: 300 },
    });
  });
});
