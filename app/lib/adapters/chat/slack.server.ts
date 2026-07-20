import { randomUUID } from "node:crypto";
import type {
  AlertChannelAdapter,
  AlertMessage,
  ProviderSendResult,
} from "../../ports";

export class SlackWebhookProvider implements AlertChannelAdapter {
  readonly kind = "slack" as const;
  readonly channelType = "slack" as const;

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async send(message: AlertMessage): Promise<ProviderSendResult> {
    const response = await this.fetcher(message.destination, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message.payload),
    });
    if (!response.ok) {
      throw new Error(`Slack webhook failed with HTTP ${response.status}`);
    }
    return {
      providerMessageId:
        response.headers.get("x-slack-request-id") ?? `slack-${randomUUID()}`,
      acceptedAt: new Date(),
    };
  }
}
