import { describe, expect, it, vi } from "vitest";
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
    const emitDelivered = vi.fn();
    const provider = new MockEmailProvider(
      outbox,
      new FakeClock(now),
      "secret",
      emitDelivered,
    );
    const result = await provider.send({
      deliveryId: "delivery-1",
      messageKey: "message-1",
      channelType: "email",
      destination: "ops@example.test",
      payload: {
        from: "alerts@alertproof.test",
        subject: "Order #1001",
        text: "A new order arrived",
      },
    });
    expect(result.providerMessageId).toMatch(/^mock-email-/);
    expect(result.acceptedAt).toEqual(now);
    expect(outbox.records).toHaveLength(1);
    expect(outbox.records[0]).toMatchObject({
      channel: "email",
      to: "ops@example.test",
      deliveryId: "delivery-1",
    });
    expect(emitDelivered).toHaveBeenCalledWith({
      providerMessageId: result.providerMessageId,
      status: "delivered",
      occurredAt: "2026-07-20T12:00:01.000Z",
    });
  });

  it("records chat and SMS sends and parses a synthetic SMS receipt", async () => {
    const outbox = new MemoryOutbox();
    const clock = new FakeClock(now);
    const chat = new MockChatProvider("slack", outbox, clock);
    const sms = new MockSmsProvider(outbox, clock);
    await chat.send({
      deliveryId: "delivery-2",
      messageKey: "message-2",
      channelType: "slack",
      destination: "mock://ops",
      payload: { text: "New order" },
    });
    const sent = await sms.send({
      deliveryId: "delivery-3",
      messageKey: "message-3",
      channelType: "sms",
      destination: "+15555550100",
      payload: { from: "+15555550123", body: "New order" },
    });
    const receipt = await sms.parseStatusEvent({
      headers: {},
      body: JSON.stringify({ providerMessageId: sent.providerMessageId }),
    });
    expect(outbox.records.map((record) => record.channel)).toEqual([
      "slack",
      "sms",
    ]);
    expect(receipt.status).toBe("delivered");
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
    expect(page.orders[0].id).toBe("1");
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
