import {
  Channel,
  DeliveryStatus,
  EventSource,
  Plan,
  Trigger,
} from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../app/db.server";
import { createAdapters } from "../../app/lib/adapters/index.server";
import { PrismaShopPlanStore } from "../../app/lib/adapters/outbox.server";
import { FakeClock } from "../../app/lib/adapters/clock/fake.server";
import { AlertDispatcher } from "../../app/lib/delivery/dispatch.server";
import { PrismaDeliveryLogStore } from "../../app/lib/delivery/log.server";
import { enqueueWebhook } from "../../app/lib/ingest/enqueue.server";
import { processRulesForEvent } from "../../app/lib/rules/handlers.server";
import { saveRule } from "../../app/lib/ui/forms.server";
import { MemoryOutbox } from "../helpers/memory";

const integration = describe.skipIf(!process.env.TEST_DATABASE_URL);
const shopId = "phase6-shop";
const shopDomain = "phase6.myshopify.com";
const now = new Date("2026-07-20T18:00:00Z");

integration("Phase 6 server-side gating", () => {
  beforeEach(async () => {
    await prisma.shop.deleteMany({ where: { id: shopId } });
    await prisma.shop.create({
      data: {
        id: shopId,
        shopDomain,
        plan: Plan.FREE,
        installedAt: new Date("2026-06-01T00:00:00Z"),
        trialEndsAt: new Date("2026-06-15T00:00:00Z"),
      },
    });
  });
  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { id: shopId } });
    await prisma.$disconnect();
  });

  async function seedSlackRule() {
    const recipient = await prisma.recipient.create({
      data: { shopId, name: "Ops", slackWebhookUrlEnc: "mock://slack" },
    });
    return prisma.rule.create({
      data: {
        shopId,
        name: "Orders",
        trigger: Trigger.ORDER_CREATED,
        conditions: {},
        recipients: {
          create: { recipientId: recipient.id, channels: [Channel.SLACK] },
        },
      },
    });
  }

  async function fire(orderId: string) {
    await enqueueWebhook(
      {
        shopDomain,
        topic: "orders/create",
        shopifyWebhookId: `phase6:${orderId}`,
        receivedAt: now,
        payload: {
          id: orderId,
          name: `#${orderId}`,
          total_price: "10.00",
          line_items: [],
        },
      },
      prisma,
    );
    const event = await prisma.webhookEvent.findUniqueOrThrow({
      where: { shopifyWebhookId: `phase6:${orderId}` },
    });
    await processRulesForEvent(event, { prisma }, { now });
  }

  it("records plan-gated channels as SKIPPED(reason=plan), then mock upgrade unlocks delivery", async () => {
    await seedSlackRule();
    await fire("free-order");
    expect(
      await prisma.delivery.findFirst({
        where: { alert: { shopId, orderId: "free-order" } },
      }),
    ).toMatchObject({ status: DeliveryStatus.SKIPPED, lastError: "plan" });
    const adapters = createAdapters(undefined, {
      outbox: new MemoryOutbox(),
      planStore: new PrismaShopPlanStore(),
      clock: new FakeClock(now),
    });
    await adapters.billing.requestSubscription({
      shopId,
      plan: "STANDARD",
      returnUrl: "http://localhost/app/billing",
    });
    await fire("standard-order");
    await new AlertDispatcher(
      new PrismaDeliveryLogStore(prisma),
      prisma,
      adapters,
      adapters.clock,
    ).dispatch();
    expect(
      await prisma.delivery.findFirst({
        where: { alert: { shopId, orderId: "standard-order" } },
      }),
    ).toMatchObject({ status: DeliveryStatus.DELIVERED, lastError: null });
  });

  it("records the 51st Free order as SKIPPED(reason=over_free_limit)", async () => {
    const recipient = await prisma.recipient.create({
      data: { shopId, name: "Owner", email: "owner@example.test" },
    });
    await prisma.rule.create({
      data: {
        shopId,
        name: "Orders",
        trigger: Trigger.ORDER_CREATED,
        conditions: {},
        recipients: {
          create: { recipientId: recipient.id, channels: [Channel.EMAIL] },
        },
      },
    });
    await prisma.webhookEvent.createMany({
      data: Array.from({ length: 50 }, (_, index) => ({
        shopDomain,
        topic: "orders/create",
        shopifyWebhookId: `usage:${index}`,
        source: EventSource.WEBHOOK,
        orderId: `usage-${index}`,
        payload: { id: `usage-${index}` },
        receivedAt: now,
      })),
    });
    await fire("order-51");
    expect(
      await prisma.usageCounter.findUniqueOrThrow({
        where: { shopId_periodYYYYMM: { shopId, periodYYYYMM: "2026-07" } },
      }),
    ).toMatchObject({ ordersProcessed: 51 });
    expect(
      await prisma.delivery.findFirst({
        where: { alert: { shopId, orderId: "order-51" } },
      }),
    ).toMatchObject({
      status: DeliveryStatus.SKIPPED,
      lastError: "over_free_limit",
    });
  });

  it("enforces the Free rule cap but gives active trials Standard capacity", async () => {
    await seedSlackRule();
    const form = new FormData();
    form.set("name", "Second rule");
    form.set("trigger", Trigger.ORDER_CREATED);
    form.set("enabled", "true");
    const recipient = await prisma.recipient.findFirstOrThrow({
      where: { shopId },
    });
    form.set("routes", `${recipient.id}:${Channel.EMAIL}`);
    expect(await saveRule(shopId, form, prisma, now)).toMatchObject({
      ok: false,
      errors: { name: [expect.stringContaining("plan allows 1")] },
    });
    await prisma.shop.update({
      where: { id: shopId },
      data: { trialEndsAt: new Date("2026-07-21T18:00:00Z") },
    });
    expect(await saveRule(shopId, form, prisma, now)).toMatchObject({
      ok: true,
    });
  });
});
