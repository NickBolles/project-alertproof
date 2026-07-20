import type {
  ProviderSendResult,
  ProviderStatusEvent,
  SmsMessage,
  SmsProvider,
  StatusWebhook,
} from "../../ports";
import { NotConfiguredError } from "../errors";

export class TwilioSmsProvider implements SmsProvider {
  readonly kind = "twilio" as const;
  constructor(
    readonly accountSid: string,
    readonly authToken: string,
    readonly fromNumber: string,
  ) {}

  send(_message: SmsMessage): Promise<ProviderSendResult> {
    throw new NotConfiguredError("TwilioSmsProvider");
  }

  parseStatusCallback(_webhook: StatusWebhook): Promise<ProviderStatusEvent> {
    throw new NotConfiguredError("TwilioSmsProvider");
  }
}
