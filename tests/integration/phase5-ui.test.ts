import { Channel, DeliveryStatus, Trigger } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../app/db.server";
import { createAdapters } from "../../app/lib/adapters/index.server";
import { FakeClock } from "../../app/lib/adapters/clock/fake.server";
import { runSyntheticTestAlert } from "../../app/lib/ui/test-alert.server";
import { saveRecipient, saveRule } from "../../app/lib/ui/forms.server";
import { MemoryOutbox, MemoryShopPlanStore } from "../helpers/memory";

const integration = describe.skipIf(!process.env.TEST_DATABASE_URL);
const shopId = "phase5-shop";
const shopDomain = "phase5.myshopify.com";
const now = new Date("2026-07-20T16:00:00.000Z");

integration("Phase 5 real service UI flows", () => {
  beforeEach(async () => {
    await prisma.shop.deleteMany({ where: { id: shopId } });
    await prisma.shop.create({
      data: {
        id: shopId,
        shopDomain,
        installedAt: now,
        trialEndsAt: new Date("2026-08-03T16:00:00Z"),
      },
    });
  });
  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { id: shopId } });
    await prisma.$disconnect();
  });

  it("round-trips recipient and rule CRUD through shared server actions", async () => {
    const recipientForm = new FormData();
    recipientForm.set("name", "Owner");
    recipientForm.set("email", "owner@example.test");
    const recipient = await saveRecipient(shopId, recipientForm, prisma);
    expect(recipient.ok).toBe(true);
    const ruleForm = new FormData();
    ruleForm.set("name", "New orders");
    ruleForm.set("trigger", Trigger.ORDER_CREATED);
    ruleForm.set("enabled", "true");
    ruleForm.append(
      "routes",
      `${recipient.ok ? recipient.id : ""}:${Channel.EMAIL}`,
    );
    const rule = await saveRule(shopId, ruleForm, prisma);
    expect(rule.ok).toBe(true);
    expect(
      await prisma.rule.findFirst({
        where: { id: rule.ok ? rule.id : "" },
        include: { recipients: true },
      }),
    ).toMatchObject({
      name: "New orders",
      recipients: [{ channels: [Channel.EMAIL] }],
    });
  });

  it("runs a TEST event through queue, rules, mock delivery, and log without usage/writeback", async () => {
    const recipient = await prisma.recipient.create({
      data: { shopId, name: "Owner", email: "owner@example.test" },
    });
    await prisma.rule.create({
      data: {
        shopId,
        name: "Every order",
        trigger: Trigger.ORDER_CREATED,
        conditions: {},
        recipients: {
          create: { recipientId: recipient.id, channels: [Channel.EMAIL] },
        },
      },
    });
    const outbox = new MemoryOutbox();
    const adapters = createAdapters(undefined, {
      outbox,
      planStore: new MemoryShopPlanStore(),
      clock: new FakeClock(now),
    });
    const alerts = await runSyntheticTestAlert({
      shopDomain,
      client: prisma,
      adapters,
      now,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].deliveries[0]).toMatchObject({
      status: DeliveryStatus.DELIVERED,
    });
    expect(outbox.records).toHaveLength(1);
    expect(
      await prisma.webhookEvent.findFirst({
        where: { shopDomain, source: "TEST" },
      }),
    ).toMatchObject({ status: "PROCESSED" });
    expect(await prisma.usageCounter.count({ where: { shopId } })).toBe(0);
    expect(alerts[0].writebackPending).toBe(false);
  });
});
