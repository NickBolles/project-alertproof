import type {
  ChatWebhookMessage,
  ChatWebhookProvider,
  ProviderSendResult,
} from "../../ports";
import { NotConfiguredError } from "../errors";

export class SlackWebhookProvider implements ChatWebhookProvider {
  readonly kind = "slack" as const;

  postToWebhookUrl(_message: ChatWebhookMessage): Promise<ProviderSendResult> {
    throw new NotConfiguredError("SlackWebhookProvider");
  }
}
