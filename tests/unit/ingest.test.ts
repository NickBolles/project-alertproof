import { describe, expect, it, vi } from "vitest";
import { retryBackoffSeconds } from "../../app/lib/ingest/processor.server";
import {
  expectedEventsForOrder,
  extractOrderId,
} from "../../app/lib/ingest/topics";
import { handleShopifyWebhook } from "../../app/lib/ingest/webhook-action.server";
import { signedShopifyWebhook } from "../helpers/webhook-signer";

describe("webhook ingest primitives", () => {
  it.each([
    ["ORDERS_CREATE", { id: 101 }, "101"],
    [
      "orders/paid",
      { id: "gid://shopify/Order/102" },
      "gid://shopify/Order/102",
    ],
    ["refunds/create", { id: 501, order_id: 103 }, "103"],
    ["ORDER_TRANSACTIONS_CREATE", { id: 601, order_id: "104" }, "104"],
    ["inventory_levels/update", { inventory_item_id: 1 }, null],
  ])("extracts the indexed order id for %s", (topic, payload, expected) => {
    expect(extractOrderId(topic, payload)).toBe(expected);
  });

  it("derives independent expected events per topic and refund resource", () => {
    const events = expectedEventsForOrder("fixture.myshopify.com", {
      id: "gid://shopify/Order/1",
      name: "#1",
      createdAt: new Date("2026-07-20T00:00:00Z"),
      updatedAt: new Date("2026-07-20T01:00:00Z"),
      financialStatus: "paid",
      refunds: [
        { id: "refund-1", createdAt: new Date("2026-07-20T01:00:00Z") },
        { id: "refund-2", createdAt: new Date("2026-07-20T02:00:00Z") },
      ],
      lineItems: [],
    });

    expect(events.map((event) => [event.topic, event.resourceId])).toEqual([
      ["orders/create", "gid://shopify/Order/1"],
      ["orders/paid", "gid://shopify/Order/1"],
      ["refunds/create", "refund-1"],
      ["refunds/create", "refund-2"],
    ]);
    expect(new Set(events.map((event) => event.syntheticWebhookId)).size).toBe(
      4,
    );
    expect(
      events.every((event) => !event.syntheticWebhookId.match(/\d{4}-\d{2}/)),
    ).toBe(true);
  });

  it("uses 30 second exponential retry backoff capped at one hour", () => {
    expect(retryBackoffSeconds(0)).toBe(30);
    expect(retryBackoffSeconds(1)).toBe(60);
    expect(retryBackoffSeconds(6)).toBe(1_920);
    expect(retryBackoffSeconds(7)).toBe(3_600);
    expect(retryBackoffSeconds(14)).toBe(3_600);
  });

  it("acks after persistence without awaiting asynchronous processing", async () => {
    const order: string[] = [];
    const enqueue = vi.fn(async () => {
      order.push("persisted");
      return {
        inserted: true,
        orderId: "1",
        resourceId: "1",
        topic: "orders/create",
      };
    });
    const kick = vi.fn(() => order.push("kicked"));
    const response = await handleShopifyWebhook(
      new Request("http://localhost/webhooks/shopify", { method: "POST" }),
      {
        authenticateWebhook: async () => ({
          payload: { id: 1 },
          shop: "fixture.myshopify.com",
          topic: "ORDERS_CREATE",
          webhookId: "webhook-1",
        }),
        enqueue,
        kick,
        now: () => 1,
        logLatency: vi.fn(),
      },
    );

    expect(response.status).toBe(200);
    expect(order).toEqual(["persisted", "kicked"]);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(kick).toHaveBeenCalledOnce();
  });

  it("rejects a bad Shopify HMAC before enqueue", async () => {
    const enqueue = vi.fn();
    const request = signedShopifyWebhook({
      payload: { id: 1 },
      topic: "orders/create",
      validSignature: false,
    });

    await expect(
      handleShopifyWebhook(request, {
        enqueue,
        kick: vi.fn(),
        logLatency: vi.fn(),
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
