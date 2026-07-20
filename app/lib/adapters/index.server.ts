import { getAdapterMode, env as defaultEnv, type Env } from "../env.server";
import type {
  ChatWebhookProvider,
  Clock,
  OutboxWriter,
  ShopPlanStore,
  ShopifyOrder,
} from "../ports";
import { MockBillingService } from "./billing/mock.server";
import { ShopifyBillingService } from "./billing/shopify.server";
import { MockChatProvider } from "./chat/mock.server";
import { DiscordWebhookProvider } from "./chat/discord.server";
import { SlackWebhookProvider } from "./chat/slack.server";
import { DateClock } from "./clock/date.server";
import { MockEmailProvider } from "./email/mock.server";
import { PostmarkEmailProvider } from "./email/postmark.server";
import { PrismaOutboxWriter, PrismaShopPlanStore } from "./outbox.server";
import { MockShopifyAdmin } from "./shopify-admin/mock.server";
import { RealShopifyAdmin } from "./shopify-admin/real.server";
import { MockSmsProvider } from "./sms/mock.server";
import { TwilioSmsProvider } from "./sms/twilio.server";

export type AdapterFactoryDependencies = {
  outbox?: OutboxWriter;
  planStore?: ShopPlanStore;
  clock?: Clock;
  shopifyFixtures?: {
    orders?: Record<string, ShopifyOrder[]>;
    timezone?: string;
  };
};

export function createAdapters(
  config: Env = defaultEnv,
  dependencies: AdapterFactoryDependencies = {},
) {
  const selectedMode = getAdapterMode(config);
  const clock = dependencies.clock ?? new DateClock();
  const outbox = dependencies.outbox ?? new PrismaOutboxWriter();
  const planStore = dependencies.planStore ?? new PrismaShopPlanStore();
  const mockChat = new MockChatProvider(outbox, clock);

  const chatFor = (
    service: "slack" | "discord",
    webhookUrl: string,
  ): ChatWebhookProvider => {
    if (selectedMode.chat === "mock" || webhookUrl.startsWith("mock://"))
      return mockChat;
    return service === "slack"
      ? new SlackWebhookProvider()
      : new DiscordWebhookProvider();
  };

  return {
    mode: selectedMode,
    clock,
    email:
      selectedMode.email === "postmark"
        ? new PostmarkEmailProvider(
            config.POSTMARK_API_TOKEN!,
            config.POSTMARK_WEBHOOK_SECRET,
          )
        : new MockEmailProvider(outbox, clock, config.CRON_SECRET),
    sms:
      selectedMode.sms === "twilio"
        ? new TwilioSmsProvider(
            config.TWILIO_ACCOUNT_SID!,
            config.TWILIO_AUTH_TOKEN!,
            config.TWILIO_FROM_NUMBER!,
          )
        : new MockSmsProvider(outbox, clock),
    shopifyAdmin:
      selectedMode.shopifyAdmin === "shopify"
        ? new RealShopifyAdmin()
        : new MockShopifyAdmin(dependencies.shopifyFixtures),
    billing:
      selectedMode.billing === "shopify"
        ? new ShopifyBillingService()
        : new MockBillingService(planStore),
    chatFor,
  };
}

export type Adapters = ReturnType<typeof createAdapters>;
