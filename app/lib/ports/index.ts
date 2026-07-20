/** Canonical portable alerts contract. Persistence maps these values to Prisma enums. */
export type ChannelType = "email" | "slack" | "discord" | "sms";
export type DeliveryStatus =
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "bounced"
  | "deferred"
  | "failed"
  | "skipped";

export const DELIVERY_STATUS_TO_PRISMA = {
  queued: "PENDING",
  sending: "SENDING",
  sent: "SENT",
  delivered: "DELIVERED",
  bounced: "BOUNCED",
  deferred: "DEFERRED",
  failed: "FAILED",
  skipped: "SKIPPED",
} as const satisfies Record<DeliveryStatus, string>;

export const CHANNEL_TYPE_TO_PRISMA = {
  email: "EMAIL",
  slack: "SLACK",
  discord: "DISCORD",
  sms: "SMS",
} as const satisfies Record<ChannelType, string>;

export type BillingPlan = "FREE" | "STANDARD" | "PRO";

export type ProviderSendResult = {
  providerMessageId: string;
  acceptedAt: Date;
};

export type StatusWebhook = {
  body: string;
  headers: Readonly<Record<string, string>>;
  /** Exact public callback URL used by providers that sign the request URL. */
  url?: string;
};

export type ProviderStatusEvent = {
  provider: string;
  providerMessageId: string;
  status: DeliveryStatus;
  occurredAt: Date;
  detail: unknown;
};

export type AlertMessage = {
  deliveryId: string;
  messageKey: string;
  channelType: ChannelType;
  destination: string;
  payload: Record<string, unknown>;
};

export interface AlertChannelAdapter {
  readonly kind: string;
  readonly channelType: ChannelType;
  send(message: AlertMessage): Promise<ProviderSendResult>;
  verifyStatusWebhook?(webhook: StatusWebhook): Promise<boolean>;
  parseStatusEvent?(webhook: StatusWebhook): Promise<ProviderStatusEvent>;
}

export type DeliveryRoute = {
  alertId: string;
  recipientId: string;
  messageKey: string;
  channelType: ChannelType;
  destination: string;
  enabled?: boolean;
  skipReason?: string;
};

export type DeliveryLogEntry = DeliveryRoute & {
  id: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: Date;
  providerMessageId?: string | null;
};

export interface DeliveryLogStore {
  record(route: DeliveryRoute): Promise<DeliveryLogEntry>;
  claimQueued(input?: {
    now?: Date;
    limit?: number;
  }): Promise<DeliveryLogEntry[]>;
  transition(input: {
    deliveryId: string;
    from: DeliveryStatus;
    to: DeliveryStatus;
    at: Date;
    providerMessageId?: string;
    detail?: unknown;
    error?: string | null;
    nextAttemptAt?: Date;
  }): Promise<boolean>;
  updateStatus(event: ProviderStatusEvent): Promise<boolean>;
}

export interface AlertDispatcher {
  dispatch(routes?: DeliveryRoute[]): Promise<{
    recorded: number;
    claimed: number;
    sent: number;
    failed: number;
  }>;
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
  channel: ChannelType;
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
