import { describe, expect, it, vi } from "vitest";
import { DiscordWebhookProvider } from "../../app/lib/adapters/chat/discord.server";
import { SlackWebhookProvider } from "../../app/lib/adapters/chat/slack.server";
import { PostmarkEmailProvider } from "../../app/lib/adapters/email/postmark.server";
import { createAdapters } from "../../app/lib/adapters/index.server";
import { DELIVERY_STATUS_TO_PRISMA } from "../../app/lib/ports";
import { renderAlertMessage } from "../../app/lib/delivery/templates.server";
import { parseEnv } from "../../app/lib/env.server";
import { validEnv } from "../helpers/env";
import { MemoryOutbox } from "../helpers/memory";

describe("canonical alerts delivery contract", () => {
  it("maps all eight portable statuses exactly to AlertProof persistence", () => {
    expect(DELIVERY_STATUS_TO_PRISMA).toEqual({
      queued: "PENDING",
      sending: "SENDING",
      sent: "SENT",
      delivered: "DELIVERED",
      bounced: "BOUNCED",
      deferred: "DEFERRED",
      failed: "FAILED",
      skipped: "SKIPPED",
    });
  });

  it.each(["email", "slack", "discord", "sms"] as const)(
    "renders a stable %s provider payload",
    (channelType) => {
      const message = renderAlertMessage({
        deliveryId: "delivery-1",
        messageKey: "rule:orders/create:1001",
        channelType,
        destination: "mock://ops",
        shopDomain: "fixture.myshopify.com",
        ruleName: "High value order",
        orderId: "gid://shopify/Order/1001",
        orderName: "#1001",
        orderValue: "500.00",
      });
      expect(message).toMatchSnapshot();
    },
  );

  it("sends through Postmark and verifies/parses authenticated callbacks", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        ErrorCode: 0,
        Message: "OK",
        MessageID: "postmark-1",
        SubmittedAt: "2026-07-20T12:00:00.000Z",
      }),
    );
    const adapter = new PostmarkEmailProvider(
      "server-token",
      "callback-user:callback-pass",
      fetcher,
    );
    const sent = await adapter.send(
      renderAlertMessage({
        deliveryId: "delivery-1",
        messageKey: "message-1",
        channelType: "email",
        destination: "ops@example.test",
        shopDomain: "fixture.myshopify.com",
        orderName: "#1001",
      }),
    );
    expect(sent.providerMessageId).toBe("postmark-1");
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.postmarkapp.com/email",
      expect.objectContaining({ method: "POST" }),
    );

    const webhook = {
      headers: {
        authorization: `Basic ${Buffer.from("callback-user:callback-pass").toString("base64")}`,
      },
      body: JSON.stringify({
        RecordType: "Delivery",
        MessageID: "postmark-1",
        DeliveredAt: "2026-07-20T12:01:00.000Z",
      }),
    };
    expect(await adapter.verifyStatusWebhook(webhook)).toBe(true);
    expect(await adapter.parseStatusEvent(webhook)).toMatchObject({
      providerMessageId: "postmark-1",
      status: "delivered",
    });
  });

  it("posts provider-shaped Slack and Discord bodies", async () => {
    const fetcher = vi.fn(async () => new Response("ok", { status: 200 }));
    for (const adapter of [
      new SlackWebhookProvider(fetcher),
      new DiscordWebhookProvider(fetcher),
    ]) {
      await adapter.send({
        deliveryId: `delivery-${adapter.kind}`,
        messageKey: `message-${adapter.kind}`,
        channelType: adapter.channelType,
        destination: `https://example.test/${adapter.kind}`,
        payload: { text: "Alert" },
      });
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("forces mock:// through a mock adapter despite real configuration", () => {
    const adapters = createAdapters(
      parseEnv({ ...validEnv, POSTMARK_API_TOKEN: "real-token" }),
      { outbox: new MemoryOutbox() },
    );
    expect(adapters.email.kind).toBe("postmark");
    expect(adapters.channelFor("email", "mock://email").kind).toBe("mock");
  });
});
