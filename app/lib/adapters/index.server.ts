import { getAdapterMode, env as defaultEnv, type Env } from "../env.server";
import type {
  AlertChannelAdapter,
  ChannelType,
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
  const mockEmail = new MockEmailProvider(outbox, clock, config.CRON_SECRET);
  const mockSms = new MockSmsProvider(outbox, clock);
  const mockSlack = new MockChatProvider("slack", outbox, clock);
  const mockDiscord = new MockChatProvider("discord", outbox, clock);
  const realEmail = config.POSTMARK_API_TOKEN
    ? new PostmarkEmailProvider(
        config.POSTMARK_API_TOKEN,
        config.POSTMARK_WEBHOOK_SECRET,
      )
    : undefined;
  const realSms =
    config.TWILIO_ACCOUNT_SID &&
    config.TWILIO_AUTH_TOKEN &&
    config.TWILIO_FROM_NUMBER
      ? new TwilioSmsProvider(
          config.TWILIO_ACCOUNT_SID,
          config.TWILIO_AUTH_TOKEN,
          config.TWILIO_FROM_NUMBER,
        )
      : undefined;

  const chatFor = (
    service: "slack" | "discord",
    webhookUrl: string,
  ): AlertChannelAdapter => {
    if (selectedMode.chat === "mock" || webhookUrl.startsWith("mock://"))
      return service === "slack" ? mockSlack : mockDiscord;
    return service === "slack"
      ? new SlackWebhookProvider()
      : new DiscordWebhookProvider();
  };

  const email = selectedMode.email === "postmark" ? realEmail! : mockEmail;
  const sms = selectedMode.sms === "twilio" ? realSms! : mockSms;
  const channelFor = (
    channelType: ChannelType,
    destination: string,
  ): AlertChannelAdapter => {
    if (destination.startsWith("mock://")) {
      if (channelType === "email") return mockEmail;
      if (channelType === "sms") return mockSms;
      return channelType === "slack" ? mockSlack : mockDiscord;
    }
    if (channelType === "email") return email;
    if (channelType === "sms") return sms;
    return chatFor(channelType, destination);
  };

  return {
    mode: selectedMode,
    clock,
    email,
    sms,
    shopifyAdmin:
      selectedMode.shopifyAdmin === "shopify"
        ? new RealShopifyAdmin()
        : new MockShopifyAdmin(dependencies.shopifyFixtures),
    billing:
      selectedMode.billing === "shopify"
        ? new ShopifyBillingService()
        : new MockBillingService(planStore),
    chatFor,
    channelFor,
  };
}

export type Adapters = ReturnType<typeof createAdapters>;
