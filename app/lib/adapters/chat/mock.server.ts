import { randomUUID } from "node:crypto";
import type {
  AlertChannelAdapter,
  AlertMessage,
  ChannelType,
  OutboxWriter,
  ProviderSendResult,
} from "../../ports";

export class MockChatProvider implements AlertChannelAdapter {
  readonly kind = "mock" as const;

  constructor(
    readonly channelType: Extract<ChannelType, "slack" | "discord">,
    private readonly outbox: OutboxWriter,
    private readonly clock: { now(): Date },
  ) {}

  async send(message: AlertMessage): Promise<ProviderSendResult> {
    const providerMessageId = `mock-${this.channelType}-${randomUUID()}`;
    await this.outbox.write({
      channel: this.channelType,
      to: message.destination,
      deliveryId: message.deliveryId,
      payload: { ...message.payload, providerMessageId },
    });
    return { providerMessageId, acceptedAt: this.clock.now() };
  }
}
