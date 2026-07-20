import type {
  AlertChannelAdapter,
  AlertMessage,
  ProviderSendResult,
  ProviderStatusEvent,
  StatusWebhook,
} from "../../ports";
import { NotConfiguredError } from "../errors";

/** SMS is intentionally plan-gated for a later phase; this preserves the canonical port. */
export class TwilioSmsProvider implements AlertChannelAdapter {
  readonly kind = "twilio" as const;
  readonly channelType = "sms" as const;

  constructor(
    readonly accountSid: string,
    readonly authToken: string,
    readonly fromNumber: string,
  ) {}

  send(_message: AlertMessage): Promise<ProviderSendResult> {
    throw new NotConfiguredError("TwilioSmsProvider (available with Pro)");
  }

  verifyStatusWebhook(): Promise<boolean> {
    throw new NotConfiguredError("TwilioSmsProvider (available with Pro)");
  }

  parseStatusEvent(_webhook: StatusWebhook): Promise<ProviderStatusEvent> {
    throw new NotConfiguredError("TwilioSmsProvider (available with Pro)");
  }
}
