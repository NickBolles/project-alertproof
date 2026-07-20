import type {
  ChatWebhookMessage,
  ChatWebhookProvider,
  ProviderSendResult,
} from "../../ports";
import { NotConfiguredError } from "../errors";

export class DiscordWebhookProvider implements ChatWebhookProvider {
  readonly kind = "discord" as const;

  postToWebhookUrl(_message: ChatWebhookMessage): Promise<ProviderSendResult> {
    throw new NotConfiguredError("DiscordWebhookProvider");
  }
}
