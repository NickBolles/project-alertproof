import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  AlertChannelAdapter,
  AlertMessage,
  ProviderSendResult,
  ProviderStatusEvent,
  StatusWebhook,
} from "../../ports";

export class TwilioSmsProvider implements AlertChannelAdapter {
  readonly kind = "twilio" as const;
  readonly channelType = "sms" as const;

  constructor(
    readonly accountSid: string,
    readonly authToken: string,
    readonly fromNumber: string,
    private readonly statusCallbackUrl?: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: { now(): Date } = { now: () => new Date() },
  ) {}

  async send(message: AlertMessage): Promise<ProviderSendResult> {
    const body = String(message.payload.body ?? "");
    const form = new URLSearchParams({
      To: message.destination,
      From: this.fromNumber,
      Body: body,
    });
    if (this.statusCallbackUrl) {
      form.set("StatusCallback", this.statusCallbackUrl);
    }
    const response = await this.fetcher(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
      },
    );
    const payload = (await response.json()) as {
      sid?: string;
      date_created?: string;
      message?: string;
    };
    if (!response.ok || !payload.sid) {
      throw new Error(
        `Twilio send failed (${response.status}): ${payload.message ?? "invalid response"}`,
      );
    }
    return {
      providerMessageId: payload.sid,
      acceptedAt: payload.date_created
        ? new Date(payload.date_created)
        : this.clock.now(),
    };
  }

  async verifyStatusWebhook(webhook: StatusWebhook): Promise<boolean> {
    const signature = webhook.headers["x-twilio-signature"];
    if (!signature || !webhook.url) return false;
    const form = new URLSearchParams(webhook.body);
    let signed = webhook.url;
    for (const key of [...new Set(form.keys())].sort()) {
      for (const value of form.getAll(key).sort()) signed += `${key}${value}`;
    }
    const expected = createHmac("sha1", this.authToken)
      .update(signed)
      .digest("base64");
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    return (
      actualBuffer.length === expectedBuffer.length &&
      timingSafeEqual(actualBuffer, expectedBuffer)
    );
  }

  async parseStatusEvent(webhook: StatusWebhook): Promise<ProviderStatusEvent> {
    const form = new URLSearchParams(webhook.body);
    const providerMessageId = form.get("MessageSid") ?? form.get("SmsSid");
    if (!providerMessageId)
      throw new Error("Twilio callback has no MessageSid");
    const providerStatus = (
      form.get("MessageStatus") ??
      form.get("SmsStatus") ??
      ""
    )
      .trim()
      .toLowerCase();
    const statuses: Record<string, ProviderStatusEvent["status"]> = {
      accepted: "sent",
      scheduled: "sent",
      queued: "sent",
      sending: "sent",
      sent: "sent",
      delivered: "delivered",
      undelivered: "bounced",
      failed: "failed",
      canceled: "failed",
    };
    const status = statuses[providerStatus];
    if (!status)
      throw new Error(`Unsupported Twilio status: ${providerStatus}`);
    return {
      provider: "twilio",
      providerMessageId,
      status,
      occurredAt: this.clock.now(),
      detail: Object.fromEntries(form.entries()),
    };
  }
}
