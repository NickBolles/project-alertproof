import { describe, expect, it } from "vitest";
import { MockBillingService } from "../../app/lib/adapters/billing/mock.server";
import { MockChatProvider } from "../../app/lib/adapters/chat/mock.server";
import { FakeClock } from "../../app/lib/adapters/clock/fake.server";
import { MockEmailProvider } from "../../app/lib/adapters/email/mock.server";
import { MockShopifyAdmin } from "../../app/lib/adapters/shopify-admin/mock.server";
import { MockSmsProvider } from "../../app/lib/adapters/sms/mock.server";
import { MemoryOutbox, MemoryShopPlanStore } from "../helpers/memory";

const now = new Date("2026-07-20T12:00:00.000Z");

describe("mock adapters", () => {
  it("MockEmailProvider.send writes MockOutbox", async () => {
    const outbox = new MemoryOutbox();
    const provider = new MockEmailProvider(
      outbox,
      new FakeClock(now),
      "secret",
    );
    const result = await provider.send({
      deliveryId: "delivery-1",
      to: "ops@example.test",
      from: "alerts@alertproof.test",
      subject: "Order #1001",
      text: "A new order arrived",
    });
    expect(result.providerMessageId).toMatch(/^mock-email-/);
    expect(result.acceptedAt).toEqual(now);
    expect(outbox.records).toHaveLength(1);
    expect(outbox.records[0]).toMatchObject({
      channel: "EMAIL",
      to: "ops@example.test",
      deliveryId: "delivery-1",
    });
  });

  it("records chat and SMS sends and parses a synthetic SMS receipt", async () => {
    const outbox = new MemoryOutbox();
    const clock = new FakeClock(now);
    const chat = new MockChatProvider(outbox, clock);
    const sms = new MockSmsProvider(outbox, clock);
    await chat.postToWebhookUrl({
      deliveryId: "delivery-2",
      service: "slack",
      webhookUrl: "mock://ops",
      payload: { text: "New order" },
    });
    const sent = await sms.send({
      deliveryId: "delivery-3",
      to: "+15555550100",
      from: "+15555550123",
      body: "New order",
    });
    const receipt = await sms.parseStatusCallback({
      headers: {},
      body: JSON.stringify({ providerMessageId: sent.providerMessageId }),
    });
    expect(outbox.records.map((record) => record.channel)).toEqual([
      "SLACK",
      "SMS",
    ]);
    expect(receipt.status).toBe("DELIVERED");
  });

  it("serves seeded Shopify orders and records writebacks", async () => {
    const shopDomain = "fixture.myshopify.com";
    const admin = new MockShopifyAdmin({
      timezone: "America/Chicago",
      orders: {
        [shopDomain]: [
          {
            id: "gid://shopify/Order/1",
            name: "#1",
            createdAt: now,
            updatedAt: now,
            refunds: [],
            lineItems: [],
          },
        ],
      },
    });
    const page = await admin.getOrdersUpdatedSince({
      shopDomain,
      updatedSince: new Date(now.getTime() - 1),
    });
    await admin.writeOrderMetafield({
      shopDomain,
      orderId: page.orders[0].id,
      namespace: "alertproof",
      key: "delivery_status",
      value: "delivered",
    });
    expect(page.orders).toHaveLength(1);
    expect(admin.metafieldWrites).toHaveLength(1);
    expect(await admin.getShopTimezone(shopDomain)).toBe("America/Chicago");
  });

  it("confirms subscriptions by changing the mock shop plan", async () => {
    const store = new MemoryShopPlanStore();
    const billing = new MockBillingService(store);
    const request = await billing.requestSubscription({
      shopId: "shop-1",
      plan: "PRO",
      returnUrl: "http://localhost:3000/app/billing",
    });
    const confirmationId = new URL(request.confirmationUrl).searchParams.get(
      "mock_confirmation_id",
    );
    expect(confirmationId).toBeTruthy();
    await billing.confirmSubscription({
      shopId: "shop-1",
      confirmationId: confirmationId!,
    });
    expect(await billing.getPlan("shop-1")).toBe("PRO");
  });
});
