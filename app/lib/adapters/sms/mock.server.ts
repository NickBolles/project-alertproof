import { randomUUID } from "node:crypto";
import type {
  AlertChannelAdapter,
  AlertMessage,
  OutboxWriter,
  ProviderSendResult,
  ProviderStatusEvent,
  StatusWebhook,
} from "../../ports";

export class MockSmsProvider implements AlertChannelAdapter {
  readonly kind = "mock" as const;
  readonly channelType = "sms" as const;

  constructor(
    private readonly outbox: OutboxWriter,
    private readonly clock: { now(): Date },
    private readonly emitDelivered?: (input: {
      providerMessageId: string;
      status: "delivered";
      occurredAt: string;
    }) => void,
  ) {}

  async send(message: AlertMessage): Promise<ProviderSendResult> {
    const providerMessageId = `mock-sms-${randomUUID()}`;
    await this.outbox.write({
      channel: "sms",
      to: message.destination,
      deliveryId: message.deliveryId,
      payload: { ...message.payload, providerMessageId },
    });
    this.emitDelivered?.({
      providerMessageId,
      status: "delivered",
      occurredAt: new Date(this.clock.now().getTime() + 1_000).toISOString(),
    });
    return { providerMessageId, acceptedAt: this.clock.now() };
  }

  async verifyStatusWebhook(): Promise<boolean> {
    return true;
  }

  async parseStatusEvent(webhook: StatusWebhook): Promise<ProviderStatusEvent> {
    const value = JSON.parse(webhook.body) as {
      providerMessageId: string;
      status?: ProviderStatusEvent["status"];
      occurredAt?: string;
    };
    return {
      provider: "mock",
      providerMessageId: value.providerMessageId,
      status: value.status ?? "delivered",
      type: value.status ?? "delivered",
      occurredAt: value.occurredAt
        ? new Date(value.occurredAt)
        : this.clock.now(),
      detail: value,
    };
  }
}
