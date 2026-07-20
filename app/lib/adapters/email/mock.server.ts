import { randomUUID, timingSafeEqual } from "node:crypto";
import type {
  AlertChannelAdapter,
  AlertMessage,
  OutboxWriter,
  ProviderSendResult,
  ProviderStatusEvent,
  StatusWebhook,
} from "../../ports";

export class MockEmailProvider implements AlertChannelAdapter {
  readonly kind = "mock" as const;
  readonly channelType = "email" as const;

  constructor(
    private readonly outbox: OutboxWriter,
    private readonly clock: { now(): Date },
    private readonly statusSecret?: string,
  ) {}

  async send(message: AlertMessage): Promise<ProviderSendResult> {
    const providerMessageId = `mock-email-${randomUUID()}`;
    await this.outbox.write({
      channel: "email",
      to: message.destination,
      deliveryId: message.deliveryId,
      payload: { ...message.payload, providerMessageId },
    });
    return { providerMessageId, acceptedAt: this.clock.now() };
  }

  async verifyStatusWebhook(webhook: StatusWebhook): Promise<boolean> {
    if (!this.statusSecret) return true;
    const provided =
      webhook.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const expected = Buffer.from(this.statusSecret);
    const actual = Buffer.from(provided);
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  async parseStatusEvent(webhook: StatusWebhook): Promise<ProviderStatusEvent> {
    const value = JSON.parse(webhook.body) as {
      providerMessageId: string;
      status: ProviderStatusEvent["status"];
      occurredAt?: string;
    };
    return {
      provider: "mock",
      providerMessageId: value.providerMessageId,
      status: value.status,
      occurredAt: value.occurredAt
        ? new Date(value.occurredAt)
        : this.clock.now(),
      detail: value,
    };
  }
}
