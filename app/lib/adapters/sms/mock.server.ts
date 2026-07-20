import { randomUUID } from "node:crypto";
import type {
  OutboxWriter,
  ProviderSendResult,
  ProviderStatusEvent,
  SmsMessage,
  SmsProvider,
  StatusWebhook,
} from "../../ports";

export class MockSmsProvider implements SmsProvider {
  readonly kind = "mock" as const;

  constructor(
    private readonly outbox: OutboxWriter,
    private readonly clock: { now(): Date },
  ) {}

  async send(message: SmsMessage): Promise<ProviderSendResult> {
    const providerMessageId = `mock-sms-${randomUUID()}`;
    await this.outbox.write({
      channel: "SMS",
      to: message.to,
      deliveryId: message.deliveryId,
      payload: { ...message, providerMessageId },
    });
    console.info(`[mock:sms] accepted ${message.deliveryId} for ${message.to}`);
    return { providerMessageId, acceptedAt: this.clock.now() };
  }

  async parseStatusCallback(
    webhook: StatusWebhook,
  ): Promise<ProviderStatusEvent> {
    const value = JSON.parse(webhook.body) as {
      providerMessageId: string;
      status?: ProviderStatusEvent["status"];
      occurredAt?: string;
    };
    return {
      provider: "mock",
      providerMessageId: value.providerMessageId,
      status: value.status ?? "DELIVERED",
      occurredAt: value.occurredAt
        ? new Date(value.occurredAt)
        : this.clock.now(),
      detail: value,
    };
  }
}
