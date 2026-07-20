import { EventStatus, type Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../app/db.server";
import { enqueueWebhook } from "../../app/lib/ingest/enqueue.server";
import {
  claimPendingEvents,
  processPending,
  reclaimStuckProcessing,
  requeueDeadEvents,
  type TopicHandler,
} from "../../app/lib/ingest/processor.server";
import { handleShopifyWebhook } from "../../app/lib/ingest/webhook-action.server";
import { signedShopifyWebhook } from "../helpers/webhook-signer";

const integration = describe.skipIf(!process.env.TEST_DATABASE_URL);
const shopDomain = "phase1-fixture.myshopify.com";
const baseTime = new Date("2026-07-20T12:00:00.000Z");

integration("webhook queue reliability", () => {
  beforeEach(async () => {
    await prisma.shop.deleteMany({ where: { shopDomain } });
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { shopDomain } });
    await prisma.$disconnect();
  });

  it("HMAC-verifies, lazily provisions, extracts orderId, and dedupes delivery IDs", async () => {
    const request = () =>
      signedShopifyWebhook({
        payload: { id: 1001, name: "#1001" },
        topic: "orders/create",
        shopDomain,
        webhookId: "duplicate-webhook-id",
      });
    const overrides = { kick: vi.fn(), logLatency: vi.fn() };

    const latencies: number[] = [];
    for (let delivery = 0; delivery < 5; delivery += 1) {
      const startedAt = performance.now();
      expect((await handleShopifyWebhook(request(), overrides)).status).toBe(
        200,
      );
      latencies.push(performance.now() - startedAt);
    }
    latencies.sort((left, right) => left - right);
    expect(latencies[2]).toBeLessThan(150);

    const events = await prisma.webhookEvent.findMany({
      where: { shopifyWebhookId: "duplicate-webhook-id" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      topic: "orders/create",
      orderId: "1001",
      status: EventStatus.PENDING,
    });
    const shop = await prisma.shop.findUnique({ where: { shopDomain } });
    expect(shop).toMatchObject({ timezone: "UTC" });
    expect(shop?.reconcileCursor).toBeInstanceOf(Date);
    expect(shop?.trialEndsAt?.getTime()).toBe(
      shop!.installedAt.getTime() + 14 * 24 * 60 * 60_000,
    );
  });

  it.each([
    ["refunds/create", { id: 501, order_id: 1001 }],
    ["order_transactions/create", { id: 601, order_id: 1002 }],
  ])("stores the reconciliation orderId for %s", async (topic, payload) => {
    await enqueueWebhook(
      {
        shopDomain,
        topic,
        shopifyWebhookId: `id:${topic}`,
        payload,
        receivedAt: baseTime,
      },
      prisma,
    );
    expect(
      await prisma.webhookEvent.findUnique({
        where: { shopifyWebhookId: `id:${topic}` },
        select: { orderId: true },
      }),
    ).toEqual({ orderId: String(payload.order_id) });
  });

  it("processes out-of-order lifecycle topics independently", async () => {
    await enqueueWebhook(
      {
        shopDomain,
        topic: "orders/paid",
        shopifyWebhookId: "paid-first",
        payload: { id: 1001 },
        receivedAt: baseTime,
      },
      prisma,
    );
    await enqueueWebhook(
      {
        shopDomain,
        topic: "orders/create",
        shopifyWebhookId: "create-second",
        payload: { id: 1001 },
        receivedAt: new Date(baseTime.getTime() + 1),
      },
      prisma,
    );

    const result = await processPending({
      client: prisma,
      now: new Date(baseTime.getTime() + 1),
    });
    expect(result).toMatchObject({ claimed: 2, processed: 2, failed: 0 });
    expect(
      await prisma.webhookEvent.count({
        where: { shopDomain, status: EventStatus.PROCESSED },
      }),
    ).toBe(2);
  });

  it("retries a crashed handler with backoff and later succeeds", async () => {
    await enqueueWebhook(
      {
        shopDomain,
        topic: "orders/create",
        shopifyWebhookId: "crash-retry",
        payload: { id: 1001 },
        receivedAt: baseTime,
      },
      prisma,
    );
    const failing: TopicHandler = async () => {
      throw new Error("simulated worker crash");
    };
    const handlers = new Map([["orders/create", failing]]);
    await processPending({
      client: prisma,
      now: baseTime,
      topicHandlers: handlers,
    });
    expect(
      await prisma.webhookEvent.findUnique({
        where: { shopifyWebhookId: "crash-retry" },
        select: { status: true, attempts: true, nextAttemptAt: true },
      }),
    ).toEqual({
      status: EventStatus.FAILED,
      attempts: 1,
      nextAttemptAt: new Date("2026-07-20T12:00:30.000Z"),
    });

    expect(
      await processPending({
        client: prisma,
        now: new Date("2026-07-20T12:00:29.999Z"),
        topicHandlers: new Map([["orders/create", vi.fn()]]),
      }),
    ).toMatchObject({ claimed: 0 });
    expect(
      await processPending({
        client: prisma,
        now: new Date("2026-07-20T12:00:30.000Z"),
        topicHandlers: new Map([["orders/create", vi.fn()]]),
      }),
    ).toMatchObject({ claimed: 1, processed: 1 });
  });

  it("dead-letters only on attempt 15 and supports explicit requeue", async () => {
    await enqueueWebhook(
      {
        shopDomain,
        topic: "orders/create",
        shopifyWebhookId: "dead-letter",
        payload: { id: 1001 },
        receivedAt: baseTime,
      },
      prisma,
    );
    await prisma.webhookEvent.update({
      where: { shopifyWebhookId: "dead-letter" },
      data: { attempts: 14 },
    });
    await processPending({
      client: prisma,
      now: baseTime,
      topicHandlers: new Map([
        [
          "orders/create",
          async () => Promise.reject(new Error("still broken")),
        ],
      ]),
    });
    expect(
      await prisma.webhookEvent.findUnique({
        where: { shopifyWebhookId: "dead-letter" },
        select: { status: true, attempts: true },
      }),
    ).toEqual({ status: EventStatus.DEAD, attempts: 15 });

    expect(await requeueDeadEvents(prisma)).toBe(1);
    expect(
      await prisma.webhookEvent.findUnique({
        where: { shopifyWebhookId: "dead-letter" },
        select: { status: true, attempts: true, lastError: true },
      }),
    ).toEqual({ status: EventStatus.PENDING, attempts: 0, lastError: null });
  });

  it("counts a stuck processing reclaim as an attempt and eventually DEAD", async () => {
    await enqueueWebhook(
      {
        shopDomain,
        topic: "orders/create",
        shopifyWebhookId: "stuck-processing",
        payload: { id: 1001 },
        receivedAt: baseTime,
      },
      prisma,
    );
    await prisma.webhookEvent.update({
      where: { shopifyWebhookId: "stuck-processing" },
      data: {
        status: EventStatus.PROCESSING,
        attempts: 14,
        updatedAt: baseTime,
      },
    });
    const reclaimed = await reclaimStuckProcessing({
      client: prisma,
      now: new Date(baseTime.getTime() + 10 * 60_000 + 1),
    });
    expect(reclaimed).toEqual({ reclaimed: 1, dead: 1 });
    expect(
      await prisma.webhookEvent.findUnique({
        where: { shopifyWebhookId: "stuck-processing" },
        select: { status: true, attempts: true },
      }),
    ).toEqual({ status: EventStatus.DEAD, attempts: 15 });
  });

  it("uses SKIP LOCKED so concurrent workers cannot claim the same row", async () => {
    await enqueueWebhook(
      {
        shopDomain,
        topic: "orders/create",
        shopifyWebhookId: "concurrent-claim",
        payload: { id: 1001 },
        receivedAt: baseTime,
      },
      prisma,
    );
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const releasePromise = new Promise<void>((resolve) => (release = resolve));
    const calls: string[] = [];
    const handler: TopicHandler = async (event) => {
      calls.push(event.id);
      started();
      await releasePromise;
    };
    const handlers = new Map([["orders/create", handler]]);

    const first = processPending({
      client: prisma,
      now: baseTime,
      topicHandlers: handlers,
    });
    await startedPromise;
    const second = await processPending({
      client: prisma,
      now: baseTime,
      topicHandlers: handlers,
    });
    release();
    await first;

    expect(second.claimed).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("claims rows in a short committed transaction", async () => {
    await enqueueWebhook(
      {
        shopDomain,
        topic: "orders/create",
        shopifyWebhookId: "direct-claim",
        payload: { id: 1001 } as Prisma.InputJsonObject,
        receivedAt: baseTime,
      },
      prisma,
    );
    expect(
      await claimPendingEvents({ client: prisma, now: baseTime }),
    ).toHaveLength(1);
  });
});
