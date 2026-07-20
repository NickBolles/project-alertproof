import { randomUUID, timingSafeEqual } from "node:crypto";
import type {
  EmailMessage,
  EmailProvider,
  OutboxWriter,
  ProviderSendResult,
  ProviderStatusEvent,
  StatusWebhook,
} from "../../ports";

export class MockEmailProvider implements EmailProvider {
  readonly kind = "mock" as const;

  constructor(
    private readonly outbox: OutboxWriter,
    private readonly clock: { now(): Date },
    private readonly statusSecret?: string,
  ) {}

  async send(message: EmailMessage): Promise<ProviderSendResult> {
    const providerMessageId = `mock-email-${randomUUID()}`;
    await this.outbox.write({
      channel: "EMAIL",
      to: message.to,
      deliveryId: message.deliveryId,
      payload: { ...message, providerMessageId },
    });
    console.info(
      `[mock:email] accepted ${message.deliveryId} for ${message.to}`,
    );
    return { providerMessageId, acceptedAt: this.clock.now() };
  }

  async verifyStatusWebhook(webhook: StatusWebhook): Promise<boolean> {
    if (!this.statusSecret) return true;
    const provided =
      webhook.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const expectedBuffer = Buffer.from(this.statusSecret);
    const providedBuffer = Buffer.from(provided);
    return (
      expectedBuffer.length === providedBuffer.length &&
      timingSafeEqual(expectedBuffer, providedBuffer)
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
