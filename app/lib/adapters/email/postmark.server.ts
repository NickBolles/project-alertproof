import { timingSafeEqual } from "node:crypto";
import type {
  AlertChannelAdapter,
  AlertMessage,
  ProviderSendResult,
  ProviderStatusEvent,
  StatusWebhook,
} from "../../ports";

type Fetch = typeof fetch;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class PostmarkEmailProvider implements AlertChannelAdapter {
  readonly kind = "postmark" as const;
  readonly channelType = "email" as const;

  constructor(
    readonly apiToken: string,
    readonly webhookSecret?: string,
    private readonly fetcher: Fetch = fetch,
  ) {}

  async send(message: AlertMessage): Promise<ProviderSendResult> {
    const response = await this.fetcher("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-postmark-server-token": this.apiToken,
      },
      body: JSON.stringify({
        From: message.payload.from,
        To: message.destination,
        Subject: message.payload.subject,
        TextBody: message.payload.text,
        HtmlBody: message.payload.html,
        Metadata: message.payload.metadata,
        MessageStream: "outbound",
      }),
    });
    const result = (await response.json().catch(() => ({}))) as {
      MessageID?: string;
      SubmittedAt?: string;
      Message?: string;
      ErrorCode?: number;
    };
    if (!response.ok || !result.MessageID || result.ErrorCode) {
      throw new Error(
        `Postmark send failed (${response.status}): ${result.Message ?? "invalid response"}`,
      );
    }
    return {
      providerMessageId: result.MessageID,
      acceptedAt: result.SubmittedAt
        ? new Date(result.SubmittedAt)
        : new Date(),
    };
  }

  async verifyStatusWebhook(webhook: StatusWebhook): Promise<boolean> {
    if (!this.webhookSecret) return false;
    const expected = `Basic ${Buffer.from(this.webhookSecret).toString("base64")}`;
    const provided = webhook.headers.authorization ?? "";
    return safeEqual(provided, expected);
  }

  async parseStatusEvent(webhook: StatusWebhook): Promise<ProviderStatusEvent> {
    const value = JSON.parse(webhook.body) as Record<string, unknown>;
    const recordType = String(value.RecordType ?? value.Type ?? "");
    const providerMessageId = String(value.MessageID ?? "");
    if (!providerMessageId)
      throw new Error("Postmark callback has no MessageID");
    const status =
      recordType.toLowerCase() === "delivery"
        ? "delivered"
        : recordType.toLowerCase() === "deferred"
          ? "deferred"
          : recordType.toLowerCase() === "bounce"
            ? "bounced"
            : null;
    if (!status) throw new Error(`Unsupported Postmark event: ${recordType}`);
    const occurred =
      value.DeliveredAt ??
      value.BouncedAt ??
      value.ReceivedAt ??
      value.ChangedAt;
    return {
      provider: "postmark",
      providerMessageId,
      status,
      occurredAt:
        typeof occurred === "string" ? new Date(occurred) : new Date(),
      detail: value,
    };
  }
}
