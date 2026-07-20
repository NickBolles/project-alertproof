export type Channel = "EMAIL" | "SLACK" | "DISCORD" | "SMS";
export type BillingPlan = "FREE" | "STANDARD" | "PRO";
export type ProviderDeliveryStatus =
  "SENT" | "DELIVERED" | "BOUNCED" | "DEFERRED" | "FAILED";

export type ProviderSendResult = {
  providerMessageId: string;
  acceptedAt: Date;
};

export type StatusWebhook = {
  body: string;
  headers: Readonly<Record<string, string>>;
};

export type ProviderStatusEvent = {
  provider: string;
  providerMessageId: string;
  status: ProviderDeliveryStatus;
  occurredAt: Date;
  detail: unknown;
};

export type EmailMessage = {
  deliveryId: string;
  to: string;
  from: string;
  subject: string;
  text: string;
  html?: string;
  metadata?: Record<string, string>;
};

export interface EmailProvider {
  readonly kind: "mock" | "postmark";
  send(message: EmailMessage): Promise<ProviderSendResult>;
  verifyStatusWebhook(webhook: StatusWebhook): Promise<boolean>;
  parseStatusEvent(webhook: StatusWebhook): Promise<ProviderStatusEvent>;
}

export type ChatWebhookMessage = {
  deliveryId: string;
  service: "slack" | "discord";
  webhookUrl: string;
  payload: Record<string, unknown>;
};

// Payload shaping occurs above this port so the mock captures the exact Slack/Discord body.
// A mock:// URL always selects MockChatProvider even when live chat delivery is enabled.
export interface ChatWebhookProvider {
  readonly kind: "mock" | "slack" | "discord";
  postToWebhookUrl(message: ChatWebhookMessage): Promise<ProviderSendResult>;
}

export type SmsMessage = {
  deliveryId: string;
  to: string;
  from: string;
  body: string;
};

export interface SmsProvider {
  readonly kind: "mock" | "twilio";
  send(message: SmsMessage): Promise<ProviderSendResult>;
  parseStatusCallback(webhook: StatusWebhook): Promise<ProviderStatusEvent>;
}

export type ShopifyOrder = {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  financialStatus?: string;
  totalPrice?: string;
  refunds: Array<{ id: string; createdAt: Date }>;
  lineItems: Array<{ productId?: string; variantId?: string; title: string }>;
};

export type OrdersPage = {
  orders: ShopifyOrder[];
  nextCursor?: string;
};

export interface ShopifyAdmin {
  readonly kind: "mock" | "shopify";
  getOrdersUpdatedSince(input: {
    shopDomain: string;
    updatedSince: Date;
    cursor?: string;
    limit?: number;
  }): Promise<OrdersPage>;
  writeOrderMetafield(input: {
    shopDomain: string;
    orderId: string;
    namespace: string;
    key: string;
    value: string;
  }): Promise<void>;
  addOrderNote(input: {
    shopDomain: string;
    orderId: string;
    note: string;
  }): Promise<void>;
  getProduct(input: { shopDomain: string; productId: string }): Promise<{
    id: string;
    title: string;
    collectionIds: string[];
  } | null>;
  getShopTimezone(shopDomain: string): Promise<string>;
}

export interface BillingService {
  readonly kind: "mock" | "shopify";
  getPlan(shopId: string): Promise<BillingPlan>;
  requestSubscription(input: {
    shopId: string;
    plan: Exclude<BillingPlan, "FREE">;
    returnUrl: string;
  }): Promise<{ confirmationUrl: string }>;
  confirmSubscription(input: {
    shopId: string;
    confirmationId: string;
  }): Promise<{ plan: BillingPlan; billingChargeId?: string }>;
}

export interface Clock {
  now(): Date;
}

export type MockOutboxRecord = {
  channel: Channel;
  to: string;
  payload: unknown;
  deliveryId?: string;
};

export interface OutboxWriter {
  write(record: MockOutboxRecord): Promise<void>;
}

export interface ShopPlanStore {
  get(shopId: string): Promise<BillingPlan | null>;
  set(
    shopId: string,
    plan: BillingPlan,
    billingChargeId?: string,
  ): Promise<void>;
}
