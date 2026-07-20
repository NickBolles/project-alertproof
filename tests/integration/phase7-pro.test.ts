import {
  AlertKind,
  Channel,
  DeliveryStatus,
  Plan,
  Trigger,
} from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../app/db.server";
import { runDailyDigests } from "../../app/lib/digest/digest.server";
import { escalateDueDeliveries } from "../../app/lib/escalation/escalate.server";

const integration = describe.skipIf(!process.env.TEST_DATABASE_URL);
const now = new Date("2026-07-20T13:00:00Z");
const shopId = "phase7-shop";

integration("Phase 7 escalation and digest idempotency", () => {
  beforeEach(async () => {
    await prisma.shop.deleteMany({ where: { id: { startsWith: "phase7-" } } });
    await prisma.shop.create({
      data: {
        id: shopId,
        shopDomain: "phase7.myshopify.com",
        plan: Plan.PRO,
        trialEndsAt: null,
        timezone: "America/Chicago",
      },
    });
  });
  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { id: { startsWith: "phase7-" } } });
    await prisma.$disconnect();
  });

  async function createSource(input: {
    suffix: string;
    status: DeliveryStatus;
    sentAt?: Date;
    shop?: string;
  }) {
    const id = input.shop ?? shopId;
    const recipient = await prisma.recipient.upsert({
      where: { id: `${id}-recipient` },
      update: {},
      create: {
        id: `${id}-recipient`,
        shopId: id,
        name: "Ops",
        email: "ops@example.test",
        slackWebhookUrlEnc: "mock://slack",
      },
    });
    const rule = await prisma.rule.create({
      data: {
        id: `${id}-rule-${input.suffix}`,
        shopId: id,
        name: `Rule ${input.suffix}`,
        trigger: Trigger.ORDER_CREATED,
        escalation: { afterMinutes: 10, channel: Channel.SLACK },
      },
    });
    const alert = await prisma.alert.create({
      data: {
        id: `${id}-alert-${input.suffix}`,
        shopId: id,
        ruleId: rule.id,
        dedupeKey: `${rule.id}:orders/create:${input.suffix}`,
        orderId: input.suffix,
        firedAt: new Date(now.getTime() - 60 * 60_000),
        writebackPending: false,
      },
    });
    return prisma.delivery.create({
      data: {
        id: `${id}-delivery-${input.suffix}`,
        alertId: alert.id,
        recipientId: recipient.id,
        channel: Channel.EMAIL,
        messageKey: alert.dedupeKey,
        destination: recipient.email!,
        status: input.status,
        sentAt: input.sentAt ?? null,
        statusAt: input.sentAt ?? now,
      },
    });
  }

  it("escalates bounce and expired SENT once, while excluding delivered, recent, and chains", async () => {
    await createSource({ suffix: "bounce", status: DeliveryStatus.BOUNCED });
    await createSource({
      suffix: "expired",
      status: DeliveryStatus.SENT,
      sentAt: new Date(now.getTime() - 11 * 60_000),
    });
    await createSource({
      suffix: "recent",
      status: DeliveryStatus.SENT,
      sentAt: new Date(now.getTime() - 9 * 60_000),
    });
    await createSource({
      suffix: "delivered",
      status: DeliveryStatus.DELIVERED,
    });

    expect(await escalateDueDeliveries({ client: prisma, now })).toMatchObject({
      created: 2,
      skipped: 0,
    });
    expect(await escalateDueDeliveries({ client: prisma, now })).toMatchObject({
      created: 0,
      scanned: 1,
    });
    expect(await prisma.delivery.count({ where: { isEscalation: true } })).toBe(
      2,
    );
    await prisma.delivery.updateMany({
      where: { isEscalation: true },
      data: { status: DeliveryStatus.BOUNCED },
    });
    await escalateDueDeliveries({ client: prisma, now });
    expect(await prisma.delivery.count({ where: { isEscalation: true } })).toBe(
      2,
    );
  });

  it("records a plan-gated escalation as SKIPPED(reason=plan)", async () => {
    await prisma.shop.update({
      where: { id: shopId },
      data: { plan: Plan.STANDARD },
    });
    await createSource({ suffix: "gated", status: DeliveryStatus.BOUNCED });
    expect(await escalateDueDeliveries({ client: prisma, now })).toMatchObject({
      created: 1,
      skipped: 1,
    });
    expect(
      await prisma.delivery.findFirstOrThrow({ where: { isEscalation: true } }),
    ).toMatchObject({
      status: DeliveryStatus.SKIPPED,
      lastError: "plan",
    });
  });

  it("does not let 100 non-escalating stale deliveries starve a due escalation", async () => {
    const recipient = await prisma.recipient.create({
      data: {
        id: "phase7-starvation-recipient",
        shopId,
        name: "Ops",
        email: "ops@example.test",
        slackWebhookUrlEnc: "mock://slack",
      },
    });
    const noEscalationRule = await prisma.rule.create({
      data: {
        id: "phase7-starvation-no-escalation",
        shopId,
        name: "No escalation",
        trigger: Trigger.ORDER_CREATED,
      },
    });
    const staleAlerts = Array.from({ length: 101 }, (_, index) => ({
      id: `phase7-starvation-alert-${index}`,
      shopId,
      ruleId: noEscalationRule.id,
      dedupeKey: `phase7-starvation:${index}`,
      firedAt: new Date(now.getTime() - 2 * 60 * 60_000),
      writebackPending: false,
    }));
    await prisma.alert.createMany({ data: staleAlerts });
    await prisma.delivery.createMany({
      data: staleAlerts.map((alert, index) => ({
        id: `phase7-starvation-delivery-${index}`,
        alertId: alert.id,
        recipientId: recipient.id,
        channel: Channel.EMAIL,
        messageKey: alert.dedupeKey,
        destination: recipient.email!,
        status: DeliveryStatus.BOUNCED,
        statusAt: new Date(now.getTime() - 2 * 60 * 60_000),
      })),
    });
    const due = await createSource({
      suffix: "behind-starvation-backlog",
      status: DeliveryStatus.BOUNCED,
    });

    expect(
      await escalateDueDeliveries({ client: prisma, now, limit: 100 }),
    ).toMatchObject({ scanned: 1, created: 1, skipped: 0 });
    expect(
      await prisma.delivery.findUnique({
        where: { escalatedFromId: due.id },
      }),
    ).toMatchObject({ isEscalation: true, channel: Channel.SLACK });
  });

  it("running the digest cron twice creates one shop-local digest delivery", async () => {
    const recipient = await prisma.recipient.create({
      data: {
        id: "phase7-digest-recipient",
        shopId,
        name: "Owner",
        email: "owner@example.test",
        digestEnabled: true,
        digestHourLocal: 8,
      },
    });
    const rule = await prisma.rule.create({
      data: {
        id: "phase7-digest-rule",
        shopId,
        name: "Orders",
        trigger: Trigger.ORDER_CREATED,
      },
    });
    const alert = await prisma.alert.create({
      data: {
        id: "phase7-digest-source",
        shopId,
        kind: AlertKind.RULE,
        ruleId: rule.id,
        dedupeKey: "phase7:digest:source",
        orderId: "1001",
        firedAt: new Date(now.getTime() - 60_000),
        writebackPending: false,
      },
    });
    await prisma.delivery.create({
      data: {
        alertId: alert.id,
        recipientId: recipient.id,
        channel: Channel.EMAIL,
        messageKey: alert.dedupeKey,
        destination: recipient.email!,
        status: DeliveryStatus.BOUNCED,
        createdAt: new Date(now.getTime() - 60_000),
      },
    });

    expect(await runDailyDigests({ client: prisma, now })).toMatchObject({
      eligible: 1,
      created: 1,
    });
    expect(await runDailyDigests({ client: prisma, now })).toMatchObject({
      eligible: 1,
      created: 0,
      duplicates: 1,
    });
    const digest = await prisma.alert.findMany({
      where: { kind: AlertKind.DIGEST, shopId },
      include: { deliveries: true },
    });
    expect(digest).toHaveLength(1);
    expect(digest[0].dedupeKey).toBe(
      "digest:phase7-digest-recipient:2026-07-20",
    );
    expect(digest[0].deliveries[0]).toMatchObject({
      status: DeliveryStatus.PENDING,
      providerDetail: expect.objectContaining({
        kind: "digest",
        counts: expect.objectContaining({ ordersAlerted: 1, bounces: 1 }),
      }),
    });
  });

  it("records a non-Pro digest as SKIPPED(reason=plan)", async () => {
    await prisma.shop.update({
      where: { id: shopId },
      data: { plan: Plan.STANDARD },
    });
    await prisma.recipient.create({
      data: {
        id: "phase7-gated-digest-recipient",
        shopId,
        name: "Owner",
        email: "owner@example.test",
        digestEnabled: true,
        digestHourLocal: 8,
      },
    });
    expect(await runDailyDigests({ client: prisma, now })).toMatchObject({
      created: 1,
      gated: 1,
    });
    expect(
      await prisma.delivery.findFirstOrThrow({
        where: { messageKey: { startsWith: "digest:" } },
      }),
    ).toMatchObject({ status: DeliveryStatus.SKIPPED, lastError: "plan" });
  });
});
