import { randomUUID } from "node:crypto";
import type {
  AlertChannelAdapter,
  AlertMessage,
  ProviderSendResult,
} from "../../ports";

export class DiscordWebhookProvider implements AlertChannelAdapter {
  readonly kind = "discord" as const;
  readonly channelType = "discord" as const;

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async send(message: AlertMessage): Promise<ProviderSendResult> {
    const response = await this.fetcher(message.destination, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message.payload),
    });
    if (!response.ok) {
      throw new Error(`Discord webhook failed with HTTP ${response.status}`);
    }
    return {
      providerMessageId:
        response.headers.get("x-ratelimit-bucket") ?? `discord-${randomUUID()}`,
      acceptedAt: new Date(),
    };
  }
}
