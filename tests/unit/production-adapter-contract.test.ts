import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PostmarkEmailProvider } from "../../app/lib/adapters/email/postmark.server";
import { MockShopifyAdmin } from "../../app/lib/adapters/shopify-admin/mock.server";
import { RealShopifyAdmin } from "../../app/lib/adapters/shopify-admin/real.server";
import { TwilioSmsProvider } from "../../app/lib/adapters/sms/twilio.server";
import { activeSubscriptionProjection } from "../../app/lib/billing/subscriptions.server";
import { expectedEventsForOrder } from "../../app/lib/ingest/topics";
import activeSubscriptionsFixture from "../fixtures/providers/shopify-active-subscriptions.json";
import mutationsFixture from "../fixtures/providers/shopify-mutations.json";
import ordersFixture from "../fixtures/providers/shopify-orders-page.json";
import postmarkFixture from "../fixtures/providers/postmark-events.json";
import twilioFixture from "../fixtures/providers/twilio-status.json";

describe("production-shape adapter contracts", () => {
  it("normalizes real GraphQL GIDs to the same numeric order contract as webhooks and mocks", async () => {
    const transport = vi.fn(async () => Response.json(ordersFixture));
    const real = new RealShopifyAdmin(transport);
    const realPage = await real.getOrdersUpdatedSince({
      shopDomain: "fixture.myshopify.com",
      updatedSince: new Date("2026-07-20T12:00:00Z"),
    });
    const mock = new MockShopifyAdmin({
      orders: {
        "fixture.myshopify.com": [
          {
            ...realPage.orders[0],
            id: "gid://shopify/Order/4001",
            refunds: [
              {
                id: "gid://shopify/Refund/9001",
                createdAt: new Date("2026-07-20T12:04:00Z"),
              },
            ],
          },
        ],
      },
    });
    const mockPage = await mock.getOrdersUpdatedSince({
      shopDomain: "fixture.myshopify.com",
      updatedSince: new Date("2026-07-20T12:00:00Z"),
    });

    expect(realPage.orders[0]).toMatchObject({
      id: "4001",
      financialStatus: "partially_refunded",
      refunds: [{ id: "9001" }],
    });
    expect(mockPage.orders[0]).toEqual(realPage.orders[0]);
    expect(
      expectedEventsForOrder("fixture.myshopify.com", realPage.orders[0]).map(
        ({ topic, orderId, resourceId }) => ({ topic, orderId, resourceId }),
      ),
    ).toEqual([
      { topic: "orders/create", orderId: "4001", resourceId: "4001" },
      { topic: "orders/paid", orderId: "4001", resourceId: "4001" },
      { topic: "refunds/create", orderId: "4001", resourceId: "9001" },
    ]);
  });

  it("converts canonical numeric order IDs to GIDs only at GraphQL mutation/query edges", async () => {
    const calls: Array<{ query: string; variables?: Record<string, unknown> }> =
      [];
    const real = new RealShopifyAdmin(async (_shop, query, variables) => {
      calls.push({ query, variables });
      if (query.includes("metafieldsSet")) {
        return Response.json(mutationsFixture.metafieldsSet);
      }
      if (query.includes("query AlertProofOrderNote")) {
        return Response.json(mutationsFixture.orderNote);
      }
      return Response.json(mutationsFixture.orderUpdate);
    });
    await real.writeOrderMetafield({
      shopDomain: "fixture.myshopify.com",
      orderId: "4001",
      namespace: "alertproof",
      key: "status",
      value: "{}",
    });
    await real.addOrderNote({
      shopDomain: "fixture.myshopify.com",
      orderId: "4001",
      note: "AlertProof: delivered",
    });

    expect(calls[0].variables).toMatchObject({
      metafields: [{ ownerId: "gid://shopify/Order/4001" }],
    });
    expect(calls[1].variables).toEqual({ id: "gid://shopify/Order/4001" });
    expect(calls[2].variables).toMatchObject({
      input: { id: "gid://shopify/Order/4001" },
    });
  });

  it("maps recorded activeSubscriptions envelopes to the same billing projection as mocks", async () => {
    const real = new RealShopifyAdmin(async () =>
      Response.json(activeSubscriptionsFixture),
    );
    const mock = new MockShopifyAdmin({
      subscriptions: {
        "fixture.myshopify.com":
          activeSubscriptionsFixture.data.currentAppInstallation
            .activeSubscriptions,
      },
    });
    const [realSubscriptions, mockSubscriptions] = await Promise.all([
      real.getActiveAppSubscriptions({ shopDomain: "fixture.myshopify.com" }),
      mock.getActiveAppSubscriptions({ shopDomain: "fixture.myshopify.com" }),
    ]);
    expect(realSubscriptions).toEqual(mockSubscriptions);
    expect(activeSubscriptionProjection(realSubscriptions)).toEqual({
      plan: "PRO",
      billingChargeId: "gid://shopify/AppSubscription/3001",
    });
  });

  it("parses recorded Postmark delivery, complaint, and unsupported event shapes", async () => {
    const adapter = new PostmarkEmailProvider("token", "user:pass");
    const parse = (payload: unknown) =>
      adapter.parseStatusEvent({
        headers: {},
        body: JSON.stringify(payload),
      });
    await expect(parse(postmarkFixture.delivery)).resolves.toMatchObject({
      status: "delivered",
      type: "Delivery",
    });
    await expect(parse(postmarkFixture.spamComplaint)).resolves.toMatchObject({
      status: "bounced",
      type: "SpamComplaint",
    });
    await expect(parse(postmarkFixture.open)).resolves.toMatchObject({
      status: null,
      type: "Open",
    });
  });

  it("parses a recorded Twilio form callback with the real signature envelope", async () => {
    const token = "twilio-token";
    const signature = createHmac("sha1", token)
      .update(
        `${twilioFixture.callbackUrl}MessageSid${twilioFixture.providerMessageId}MessageStatusundelivered`,
      )
      .digest("base64");
    const adapter = new TwilioSmsProvider(
      "AC4001",
      token,
      "+13125550100",
      twilioFixture.callbackUrl,
      vi.fn(),
      { now: () => new Date("2026-07-20T12:09:00Z") },
    );
    const webhook = {
      url: twilioFixture.callbackUrl,
      body: twilioFixture.body,
      headers: { "x-twilio-signature": signature },
    };
    await expect(adapter.verifyStatusWebhook(webhook)).resolves.toBe(true);
    await expect(adapter.parseStatusEvent(webhook)).resolves.toMatchObject({
      providerMessageId: twilioFixture.providerMessageId,
      status: twilioFixture.expectedStatus,
      type: "undelivered",
    });
  });
});
