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
    ["orders/paid", { id: "gid://shopify/Order/102" }, "102"],
    ["refunds/create", { id: 501, order_id: 103 }, "103"],
    ["ORDER_TRANSACTIONS_CREATE", { id: 601, order_id: "104" }, "104"],
    ["inventory_levels/update", { inventory_item_id: 1 }, null],
  ])("extracts the indexed order id for %s", (topic, payload, expected) => {
    expect(extractOrderId(topic, payload)).toBe(expected);
  });

  it("derives paid expectations for refunded orders and canonical refund resources", () => {
    const events = expectedEventsForOrder("fixture.myshopify.com", {
      id: "gid://shopify/Order/1",
      name: "#1",
      createdAt: new Date("2026-07-20T00:00:00Z"),
      updatedAt: new Date("2026-07-20T01:00:00Z"),
      financialStatus: "refunded",
      refunds: [
        {
          id: "gid://shopify/Refund/201",
          createdAt: new Date("2026-07-20T01:00:00Z"),
        },
        { id: "202", createdAt: new Date("2026-07-20T02:00:00Z") },
      ],
      lineItems: [],
    });

    expect(events.map((event) => [event.topic, event.resourceId])).toEqual([
      ["orders/create", "1"],
      ["orders/paid", "1"],
      ["refunds/create", "201"],
      ["refunds/create", "202"],
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

  it("assigns unique webhook IDs when Shopify omits the delivery ID", async () => {
    const ids: string[] = [];
    const enqueue = vi.fn(async (input: { shopifyWebhookId: string }) => {
      ids.push(input.shopifyWebhookId);
      return {
        inserted: true,
        orderId: "1",
        resourceId: "1",
        topic: "orders/create",
      };
    });
    const request = () =>
      new Request("http://localhost/webhooks/shopify", { method: "POST" });
    const overrides = {
      authenticateWebhook: async () => ({
        payload: { id: 1 },
        shop: "fixture.myshopify.com",
        topic: "ORDERS_CREATE" as never,
        webhookId: "",
      }),
      enqueue,
      kick: vi.fn(),
      logLatency: vi.fn(),
    };
    await handleShopifyWebhook(request(), overrides);
    await handleShopifyWebhook(request(), overrides);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]);
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
