import { randomUUID } from "node:crypto";
import type {
  ChatWebhookMessage,
  ChatWebhookProvider,
  OutboxWriter,
  ProviderSendResult,
} from "../../ports";

export class MockChatProvider implements ChatWebhookProvider {
  readonly kind = "mock" as const;

  constructor(
    private readonly outbox: OutboxWriter,
    private readonly clock: { now(): Date },
  ) {}

  async postToWebhookUrl(
    message: ChatWebhookMessage,
  ): Promise<ProviderSendResult> {
    const providerMessageId = `mock-chat-${randomUUID()}`;
    await this.outbox.write({
      channel: message.service === "slack" ? "SLACK" : "DISCORD",
      to: message.webhookUrl,
      deliveryId: message.deliveryId,
      payload: { ...message.payload, providerMessageId },
    });
    console.info(`[mock:${message.service}] accepted ${message.deliveryId}`);
    return { providerMessageId, acceptedAt: this.clock.now() };
  }
}
