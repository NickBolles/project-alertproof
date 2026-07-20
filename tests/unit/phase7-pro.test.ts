import { createHmac } from "node:crypto";
import { DeliveryStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { TwilioSmsProvider } from "../../app/lib/adapters/sms/twilio.server";
import { createAdapters } from "../../app/lib/adapters/index.server";
import {
  buildDigestContent,
  localTimeAt,
} from "../../app/lib/digest/digest.server";
import { parseEnv } from "../../app/lib/env.server";
import {
  decryptTwilioCredentials,
  withEncryptedTwilioCredentials,
} from "../../app/lib/sms/credentials.server";
import { validEnv } from "../helpers/env";
import { MemoryOutbox } from "../helpers/memory";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("Phase 7 Pro adapters and time handling", () => {
  it("stores all BYO Twilio credentials as one AES-GCM ciphertext", () => {
    const credentials = {
      accountSid: "ACmerchant",
      authToken: "merchant-token",
      fromNumber: "+13125550100",
    };
    const settings = withEncryptedTwilioCredentials({}, credentials, key);
    const serialized = JSON.stringify(settings);
    expect(serialized).toContain("v1:");
    expect(serialized).not.toContain(credentials.accountSid);
    expect(serialized).not.toContain(credentials.authToken);
    expect(serialized).not.toContain(credentials.fromNumber);
    expect(decryptTwilioCredentials(settings, key)).toEqual(credentials);
  });

  it("resolves SMS credentials merchant first, then app, then mock", () => {
    const configured = parseEnv({
      ...validEnv,
      TWILIO_ACCOUNT_SID: "ACapp",
      TWILIO_AUTH_TOKEN: "app-token",
      TWILIO_FROM_NUMBER: "+13125550101",
    });
    const merchantSettings = withEncryptedTwilioCredentials(
      {},
      {
        accountSid: "ACmerchant",
        authToken: "merchant-token",
        fromNumber: "+13125550100",
      },
      key,
    );
    const appAdapters = createAdapters(configured, {
      outbox: new MemoryOutbox(),
    });
    expect(appAdapters.smsForShop(merchantSettings)).toMatchObject({
      kind: "twilio",
      accountSid: "ACmerchant",
    });
    expect(appAdapters.smsForShop({})).toMatchObject({
      kind: "twilio",
      accountSid: "ACapp",
    });
    const mockAdapters = createAdapters(
      parseEnv({
        ...validEnv,
        TWILIO_ACCOUNT_SID: "ACapp",
        TWILIO_AUTH_TOKEN: "app-token",
        TWILIO_FROM_NUMBER: "+13125550101",
        ALERTPROOF_FORCE_MOCKS: "1",
      }),
      { outbox: new MemoryOutbox() },
    );
    expect(mockAdapters.smsForShop(merchantSettings).kind).toBe("mock");
  });

  it("sends through Twilio and maps signed callback statuses", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ sid: "SM123", date_created: "2026-07-20T13:00:00Z" }),
    );
    const callbackUrl = "https://app.example/webhooks/sms-status";
    const adapter = new TwilioSmsProvider(
      "AC123",
      "token",
      "+13125550100",
      callbackUrl,
      fetcher,
      { now: () => new Date("2026-07-20T13:01:00Z") },
    );
    await expect(
      adapter.send({
        deliveryId: "delivery-1",
        messageKey: "message-1",
        channelType: "sms",
        destination: "+13125550102",
        payload: { body: "Alert" },
      }),
    ).resolves.toMatchObject({ providerMessageId: "SM123" });
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/Accounts/AC123/Messages.json"),
      expect.objectContaining({ method: "POST" }),
    );

    const body = "MessageSid=SM123&MessageStatus=undelivered";
    const signed = `${callbackUrl}MessageSidSM123MessageStatusundelivered`;
    const signature = createHmac("sha1", "token")
      .update(signed)
      .digest("base64");
    const webhook = {
      body,
      url: callbackUrl,
      headers: { "x-twilio-signature": signature },
    };
    await expect(adapter.verifyStatusWebhook(webhook)).resolves.toBe(true);
    await expect(adapter.parseStatusEvent(webhook)).resolves.toMatchObject({
      providerMessageId: "SM123",
      status: "bounced",
    });
    await expect(
      adapter.verifyStatusWebhook({
        ...webhook,
        headers: { "x-twilio-signature": "invalid" },
      }),
    ).resolves.toBe(false);
  });

  it.each([
    ["UTC", "2026-07-20T08:00:00Z", "2026-07-20", 8],
    ["America/Chicago", "2026-07-20T13:00:00Z", "2026-07-20", 8],
    ["Asia/Tokyo", "2026-07-19T23:00:00Z", "2026-07-20", 8],
    ["America/Chicago", "2026-11-01T07:30:00Z", "2026-11-01", 1],
    ["America/Chicago", "2026-11-01T08:30:00Z", "2026-11-01", 2],
  ])(
    "selects digest local time in %s at %s",
    (timezone, instant, date, hour) => {
      expect(localTimeAt(new Date(instant), timezone)).toEqual({ date, hour });
    },
  );

  it("renders deterministic digest content and highlights bounces", () => {
    expect(
      buildDigestContent({
        shopDomain: "fixture.myshopify.com",
        localDate: "2026-07-20",
        ordersAlerted: 3,
        deliveryStatuses: [
          DeliveryStatus.DELIVERED,
          DeliveryStatus.BOUNCED,
          DeliveryStatus.DELIVERED,
        ],
      }),
    ).toMatchInlineSnapshot(`
      {
        "counts": {
          "bounces": 1,
          "deliveries": {
            "bounced": 1,
            "delivered": 2,
          },
          "ordersAlerted": 3,
        },
        "html": "<h1>AlertProof daily digest — 2026-07-20</h1><p>Shop: fixture.myshopify.com</p><p>Orders alerted: 3</p><p>Deliveries: bounced: 1, delivered: 2.</p><p><strong>Attention: 1 bounced.</strong></p>",
        "kind": "digest",
        "subject": "AlertProof daily digest — 2026-07-20",
        "text": "AlertProof daily digest — 2026-07-20
      Shop: fixture.myshopify.com
      Orders alerted: 3
      Deliveries: bounced: 1, delivered: 2. Attention: 1 bounced.",
      }
    `);
  });
});
