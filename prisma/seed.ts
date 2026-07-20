import { Prisma, PrismaClient, Trigger, type Channel } from "@prisma/client";

const prisma = new PrismaClient();
const shopId = "seed-shop";

async function main() {
  const installedAt = new Date("2026-07-20T12:00:00.000Z");
  await prisma.shop.upsert({
    where: { id: shopId },
    update: {},
    create: {
      id: shopId,
      shopDomain: "alertproof-dev.myshopify.com",
      installedAt,
      trialEndsAt: new Date("2026-08-03T12:00:00.000Z"),
      reconcileCursor: installedAt,
      timezone: "America/Chicago",
    },
  });

  const recipients = [
    {
      id: "seed-recipient-owner",
      name: "Store Owner",
      email: "owner@example.test",
    },
    { id: "seed-recipient-ops", name: "Operations", email: "ops@example.test" },
  ];
  for (const recipient of recipients) {
    await prisma.recipient.upsert({
      where: { id: recipient.id },
      update: recipient,
      create: { ...recipient, shopId },
    });
  }

  const rules: Array<{
    id: string;
    name: string;
    trigger: Trigger;
    conditions: Prisma.InputJsonValue;
    recipientId: string;
    channels: Channel[];
  }> = [
    {
      id: "seed-rule-new-order",
      name: "Every new order",
      trigger: Trigger.ORDER_CREATED,
      conditions: {},
      recipientId: "seed-recipient-owner",
      channels: ["EMAIL"],
    },
    {
      id: "seed-rule-high-value",
      name: "High-value orders",
      trigger: Trigger.ORDER_VALUE_GTE,
      conditions: { minValue: "500.00" },
      recipientId: "seed-recipient-ops",
      channels: ["EMAIL", "SLACK"],
    },
    {
      id: "seed-rule-refund",
      name: "Refunds",
      trigger: Trigger.REFUND_CREATED,
      conditions: {},
      recipientId: "seed-recipient-owner",
      channels: ["EMAIL"],
    },
  ];
  for (const rule of rules) {
    await prisma.rule.upsert({
      where: { id: rule.id },
      update: {
        name: rule.name,
        trigger: rule.trigger,
        conditions: rule.conditions,
      },
      create: {
        id: rule.id,
        shopId,
        name: rule.name,
        trigger: rule.trigger,
        conditions: rule.conditions,
      },
    });
    await prisma.ruleRecipient.upsert({
      where: {
        ruleId_recipientId: { ruleId: rule.id, recipientId: rule.recipientId },
      },
      update: { channels: rule.channels },
      create: {
        ruleId: rule.id,
        recipientId: rule.recipientId,
        channels: rule.channels,
      },
    });
  }

  const sampleOrders = [
    {
      id: "gid://shopify/Order/1001",
      name: "#1001",
      total_price: "129.00",
      financial_status: "paid",
      created_at: "2026-07-20T12:05:00.000Z",
      updated_at: "2026-07-20T12:05:00.000Z",
      line_items: [
        { product_id: "gid://shopify/Product/2001", title: "Sample Bouquet" },
      ],
      refunds: [],
    },
    {
      id: "gid://shopify/Order/1002",
      name: "#1002",
      total_price: "750.00",
      financial_status: "pending",
      created_at: "2026-07-20T12:10:00.000Z",
      updated_at: "2026-07-20T12:10:00.000Z",
      line_items: [
        { product_id: "gid://shopify/Product/2002", title: "Sample Equipment" },
      ],
      refunds: [],
    },
  ];
  for (const order of sampleOrders) {
    await prisma.webhookEvent.upsert({
      where: { shopifyWebhookId: `seed:orders/create:${order.id}` },
      update: { payload: order },
      create: {
        shopDomain: "alertproof-dev.myshopify.com",
        topic: "orders/create",
        shopifyWebhookId: `seed:orders/create:${order.id}`,
        source: "TEST",
        orderId: order.id,
        payload: order,
        status: "PROCESSED",
        processedAt: new Date(order.updated_at),
      },
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
