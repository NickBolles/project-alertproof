import type {
  EmailMessage,
  EmailProvider,
  ProviderSendResult,
  ProviderStatusEvent,
  StatusWebhook,
} from "../../ports";
import { NotConfiguredError } from "../errors";

export class PostmarkEmailProvider implements EmailProvider {
  readonly kind = "postmark" as const;
  constructor(
    readonly apiToken: string,
    readonly webhookSecret?: string,
  ) {}

  send(_message: EmailMessage): Promise<ProviderSendResult> {
    throw new NotConfiguredError("PostmarkEmailProvider");
  }

  verifyStatusWebhook(_webhook: StatusWebhook): Promise<boolean> {
    throw new NotConfiguredError("PostmarkEmailProvider");
  }

  parseStatusEvent(_webhook: StatusWebhook): Promise<ProviderStatusEvent> {
    throw new NotConfiguredError("PostmarkEmailProvider");
  }
}
