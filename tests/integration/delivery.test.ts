import { DeliveryStatus, type PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../app/db.server";
import { createAdapters } from "../../app/lib/adapters/index.server";
import { FakeClock } from "../../app/lib/adapters/clock/fake.server";
import { AlertDispatcher } from "../../app/lib/delivery/dispatch.server";
import {
  PrismaDeliveryLogStore,
  reclaimStuckDeliveries,
} from "../../app/lib/delivery/log.server";
import { handleProviderStatusWebhook } from "../../app/lib/delivery/status.server";
import { parseEnv } from "../../app/lib/env.server";
import type { AlertChannelAdapter } from "../../app/lib/ports";
import { validEnv } from "../helpers/env";
import { MemoryOutbox } from "../helpers/memory";

const integration = describe.skipIf(!process.env.TEST_DATABASE_URL);
const shopDomain = "phase3-fixture.myshopify.com";
const now = new Date("2026-07-20T12:00:00.000Z");

async function seedRoute(client: PrismaClient, suffix: string) {
  const shop = await client.shop.findUniqueOrThrow({ where: { shopDomain } });
  const recipient = await client.recipient.create({
    data: {
      id: `recipient-${suffix}`,
      shopId: shop.id,
      name: "Ops",
      email: "mock://ops",
    },
  });
  const alert = await client.alert.create({
    data: {
      id: `alert-${suffix}`,
      shopId: shop.id,
      dedupeKey: `message-${suffix}`,
      orderId: `gid://shopify/Order/${suffix}`,
      orderName: `#${suffix}`,
    },
  });
  return {
    alertId: alert.id,
    recipientId: recipient.id,
    messageKey: alert.dedupeKey,
    channelType: "email" as const,
    destination: recipient.email!,
  };
}

integration("delivery persistence and dispatch", () => {
  beforeEach(async () => {
    await prisma.providerEvent.deleteMany();
    await prisma.shop.deleteMany({ where: { shopDomain } });
    await prisma.shop.create({
      data: {
        id: "phase3-shop",
        shopDomain,
        installedAt: now,
        reconcileCursor: now,
      },
    });
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { shopDomain } });
    await prisma.$disconnect();
  });

  it("record deduplicates routes and concurrent claim sends once", async () => {
    const route = await seedRoute(prisma, "1001");
    const store = new PrismaDeliveryLogStore(prisma);
    const [first, second] = await Promise.all([
      store.record(route),
      store.record(route),
    ]);
    expect(first.id).toBe(second.id);
    expect(
      await prisma.delivery.count({ where: { alertId: route.alertId } }),
    ).toBe(1);
    const [left, right] = await Promise.all([
      store.claimQueued({ now }),
      store.claimQueued({ now }),
    ]);
    expect(left.length + right.length).toBe(1);
  });

  it("dispatches one mock send and auto-confirms delivery", async () => {
    const route = await seedRoute(prisma, "1002");
    const store = new PrismaDeliveryLogStore(prisma);
    await store.record(route);
    const outbox = new MemoryOutbox();
    const clock = new FakeClock(now);
    const adapters = createAdapters(
      parseEnv({ ...validEnv, ALERTPROOF_FORCE_MOCKS: "1" }),
      { outbox, clock },
    );
    const result = await new AlertDispatcher(
      store,
      prisma,
      adapters,
      clock,
    ).dispatch();
    expect(result).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
    expect(outbox.records).toHaveLength(1);
    expect(await prisma.delivery.findFirst()).toMatchObject({
      status: DeliveryStatus.DELIVERED,
      attempts: 1,
    });
    await new AlertDispatcher(store, prisma, adapters, clock).dispatch();
    expect(outbox.records).toHaveLength(1);
  });

  it("backs off and fails after at most three adapter attempts", async () => {
    const route = await seedRoute(prisma, "1003");
    const store = new PrismaDeliveryLogStore(prisma);
    await store.record(route);
    const clock = new FakeClock(now);
    const base = createAdapters(parseEnv(validEnv), {
      outbox: new MemoryOutbox(),
      clock,
    });
    const failing: AlertChannelAdapter = {
      kind: "failing",
      channelType: "email",
      send: vi.fn(async () =>
        Promise.reject(new Error("provider unavailable")),
      ),
    };
    const adapters = { ...base, channelFor: () => failing };
    const dispatcher = new AlertDispatcher(store, prisma, adapters, clock);
    await dispatcher.dispatch();
    expect(await prisma.delivery.findFirst()).toMatchObject({
      status: DeliveryStatus.PENDING,
      attempts: 1,
    });
    clock.set(new Date(now.getTime() + 30_000));
    await dispatcher.dispatch();
    clock.set(new Date(now.getTime() + 90_000));
    await dispatcher.dispatch();
    expect(failing.send).toHaveBeenCalledTimes(3);
    expect(await prisma.delivery.findFirst()).toMatchObject({
      status: DeliveryStatus.FAILED,
      attempts: 3,
      lastError: "provider unavailable",
    });
  });

  it("reclaims stale SENDING rows and eventually marks them FAILED", async () => {
    const route = await seedRoute(prisma, "1004");
    const delivery = await new PrismaDeliveryLogStore(prisma).record(route);
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: DeliveryStatus.SENDING, statusAt: now },
    });
    expect(
      await reclaimStuckDeliveries({
        client: prisma,
        now: new Date(now.getTime() + 10 * 60_000 + 1),
      }),
    ).toEqual({ requeued: 1, failed: 0 });
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: DeliveryStatus.SENDING, attempts: 2, statusAt: now },
    });
    expect(
      await reclaimStuckDeliveries({
        client: prisma,
        now: new Date(now.getTime() + 10 * 60_000 + 1),
      }),
    ).toEqual({ requeued: 0, failed: 1 });
  });

  it("records callbacks, tolerates unknown IDs, and never regresses DELIVERED", async () => {
    const route = await seedRoute(prisma, "1005");
    const store = new PrismaDeliveryLogStore(prisma);
    const delivery = await store.record(route);
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: {
        status: DeliveryStatus.SENT,
        providerMessageId: "provider-1005",
      },
    });
    const adapter = createAdapters(parseEnv(validEnv), {
      outbox: new MemoryOutbox(),
      clock: new FakeClock(now),
    }).channelFor("email", "mock://status");
    const callback = (providerMessageId: string, status: string) =>
      handleProviderStatusWebhook({
        adapter,
        client: prisma,
        store,
        webhook: {
          headers: { authorization: `Bearer ${validEnv.CRON_SECRET}` },
          body: JSON.stringify({ providerMessageId, status, occurredAt: now }),
        },
      });
    await callback("provider-1005", "deferred");
    await callback("provider-1005", "delivered");
    await callback("provider-1005", "bounced");
    expect(
      await prisma.delivery.findUnique({ where: { id: delivery.id } }),
    ).toMatchObject({
      status: DeliveryStatus.DELIVERED,
    });
    expect(await callback("unknown", "delivered")).toEqual({
      accepted: true,
      matched: false,
    });
    expect(await prisma.providerEvent.count()).toBe(4);
  });
});
