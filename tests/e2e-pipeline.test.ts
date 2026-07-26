import {
  Channel,
  DeliveryStatus,
  EventStatus,
  Plan,
  Trigger,
} from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../app/db.server";
import { createAdapters } from "../app/lib/adapters/index.server";
import { FakeClock } from "../app/lib/adapters/clock/fake.server";
import { AlertDispatcher } from "../app/lib/delivery/dispatch.server";
import { PrismaDeliveryLogStore } from "../app/lib/delivery/log.server";
import { handleProviderStatusWebhook } from "../app/lib/delivery/status.server";
import { escalateDueDeliveries } from "../app/lib/escalation/escalate.server";
import { parseEnv } from "../app/lib/env.server";
import { processPending } from "../app/lib/ingest/processor.server";
import { handleShopifyWebhook } from "../app/lib/ingest/webhook-action.server";
import { processRulesForEvent } from "../app/lib/rules/handlers.server";
import highValueOrder from "./fixtures/order-high-value-product.json";
import { validEnv } from "./helpers/env";
import { MemoryOutbox } from "./helpers/memory";
import { signedShopifyWebhook } from "./helpers/webhook-signer";

const e2e = describe.skipIf(!process.env.TEST_DATABASE_URL);
const shopDomain = "e2e-pipeline.myshopify.com";
// Delivery.nextAttemptAt is assigned by the database's `now()` default. Keep
// the fake dispatcher clock ahead of that write so this test exercises the
// queued delivery rather than a historical test timestamp.
const now = new Date(Date.now() + 5 * 60_000);

e2e("signed webhook to terminal delivery", () => {
  beforeEach(async () => {
    await prisma.shop.deleteMany({ where: { shopDomain } });
    await prisma.shop.create({
      data: {
        id: "e2e-shop",
        shopDomain,
        plan: Plan.PRO,
        installedAt: now,
        reconcileCursor: now,
      },
    });
    await prisma.recipient.create({
      data: {
        id: "e2e-recipient",
        shopId: "e2e-shop",
        name: "Ops",
        email: "mock://ops",
        slackWebhookUrlEnc: "mock://slack",
      },
    });
    await prisma.rule.create({
      data: {
        id: "e2e-rule",
        shopId: "e2e-shop",
        name: "Every new order",
        trigger: Trigger.ORDER_CREATED,
        escalation: { afterMinutes: 10, channel: Channel.SLACK },
        recipients: {
          create: { recipientId: "e2e-recipient", channels: ["EMAIL"] },
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { shopDomain } });
    await prisma.$disconnect();
  });

  it("dedupes the webhook and drives SENT to bounce to one delivered escalation", async () => {
    const request = () =>
      signedShopifyWebhook({
        payload: highValueOrder,
        topic: "orders/create",
        shopDomain,
        webhookId: "e2e-webhook-id",
      });
    expect(
      (await handleShopifyWebhook(request(), { kick: () => undefined })).status,
    ).toBe(200);
    expect(
      (await handleShopifyWebhook(request(), { kick: () => undefined })).status,
    ).toBe(200);
    await processPending({
      client: prisma,
      now,
      topicHandlers: new Map([
        [
          "orders/create",
          (event, context) => processRulesForEvent(event, context, { now }),
        ],
      ]),
    });
    expect(await prisma.webhookEvent.count({ where: { shopDomain } })).toBe(1);
    expect(await prisma.alert.count({ where: { shopId: "e2e-shop" } })).toBe(1);

    const outbox = new MemoryOutbox();
    const clock = new FakeClock(now);
    const adapters = createAdapters(
      parseEnv({ ...validEnv, ALERTPROOF_FORCE_MOCKS: "1" }),
      { outbox, clock },
    );
    const store = new PrismaDeliveryLogStore(prisma);
    await new AlertDispatcher(store, prisma, adapters, clock).dispatch();
    const delivery = await prisma.delivery.findFirstOrThrow({
      where: { alert: { shopId: "e2e-shop" } },
    });
    expect(delivery.status).toBe(DeliveryStatus.SENT);
    expect(outbox.records).toHaveLength(1);

    await handleProviderStatusWebhook({
      adapter: adapters.channelFor("email", "mock://status"),
      client: prisma,
      store,
      webhook: {
        headers: { authorization: `Bearer ${validEnv.CRON_SECRET}` },
        body: JSON.stringify({
          providerMessageId: delivery.providerMessageId,
          status: "bounced",
          occurredAt: new Date(now.getTime() + 1_000),
        }),
      },
    });
    expect(
      await prisma.delivery.findUnique({ where: { id: delivery.id } }),
    ).toMatchObject({
      status: DeliveryStatus.BOUNCED,
    });
    expect(
      await escalateDueDeliveries({
        client: prisma,
        now: new Date(now.getTime() + 1_000),
      }),
    ).toMatchObject({ created: 1, skipped: 0 });
    clock.set(new Date(now.getTime() + 1_000));
    await new AlertDispatcher(store, prisma, adapters, clock).dispatch();
    expect(outbox.records).toHaveLength(2);
    expect(
      await prisma.delivery.findFirstOrThrow({
        where: { alertId: delivery.alertId, isEscalation: true },
      }),
    ).toMatchObject({
      channel: Channel.SLACK,
      status: DeliveryStatus.DELIVERED,
      escalatedFromId: delivery.id,
    });
    expect(
      await prisma.webhookEvent.findFirst({ where: { shopDomain } }),
    ).toMatchObject({
      status: EventStatus.PROCESSED,
    });
  });
});
