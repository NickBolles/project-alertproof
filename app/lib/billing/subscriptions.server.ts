import type { PrismaClient } from "@prisma/client";
import { PrismaShopPlanStore } from "../adapters/outbox.server";
import {
  registerTopicHandler,
  type ProcessableWebhookEvent,
} from "../ingest/processor.server";
import { SHOPIFY_TOPICS } from "../ingest/topics";
import type {
  BillingPlan,
  ShopPlanStore,
  ShopifyAdmin,
  ShopifyAppSubscription,
} from "../ports";

const PLAN_RANK: Record<BillingPlan, number> = {
  FREE: 0,
  STANDARD: 1,
  PRO: 2,
};

export function planFromSubscriptionName(name: string): BillingPlan | null {
  const normalized = name.trim().toLowerCase();
  if (/\bpro\b/.test(normalized)) return "PRO";
  if (/\bstandard\b/.test(normalized)) return "STANDARD";
  return null;
}

export function activeSubscriptionProjection(
  subscriptions: readonly ShopifyAppSubscription[],
): { plan: BillingPlan; billingChargeId?: string } {
  const active = subscriptions.filter(
    (subscription) => subscription.status.trim().toUpperCase() === "ACTIVE",
  );
  const recognized = active
    .map((subscription) => ({
      subscription,
      plan: planFromSubscriptionName(subscription.name),
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        subscription: ShopifyAppSubscription;
        plan: Exclude<BillingPlan, "FREE">;
      } => candidate.plan !== null,
    )
    .sort((left, right) => PLAN_RANK[right.plan] - PLAN_RANK[left.plan]);
  if (active.length > 0 && recognized.length === 0) {
    throw new Error(
      `Active Shopify subscription has no recognized AlertProof plan: ${active.map((item) => item.name).join(", ")}`,
    );
  }
  return recognized[0]
    ? {
        plan: recognized[0].plan,
        billingChargeId: recognized[0].subscription.id,
      }
    : { plan: "FREE" };
}

function subscriptionFromPayload(
  payload: Record<string, unknown>,
): ShopifyAppSubscription {
  const nested = payload.app_subscription ?? payload.appSubscription ?? payload;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    throw new Error("Shopify subscription webhook has no subscription object");
  }
  const subscription = nested as Record<string, unknown>;
  const id = String(subscription.admin_graphql_api_id ?? subscription.id ?? "");
  const name = String(subscription.name ?? "");
  const status = String(subscription.status ?? "");
  if (!id || !name || !status) {
    throw new Error(
      "Shopify subscription webhook is missing id, name, or status",
    );
  }
  return { id, name, status };
}

export async function processSubscriptionUpdateEvent(
  event: ProcessableWebhookEvent,
  context: { prisma: PrismaClient },
  planStore: ShopPlanStore = new PrismaShopPlanStore(context.prisma),
): Promise<void> {
  if (
    !event.payload ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload)
  ) {
    throw new Error(`Subscription webhook ${event.id} has no payload`);
  }
  const subscription = subscriptionFromPayload(
    event.payload as Record<string, unknown>,
  );
  const shop = await context.prisma.shop.findUniqueOrThrow({
    where: { shopDomain: event.shopDomain },
    select: { id: true },
  });
  const projection = activeSubscriptionProjection(
    subscription.status.toUpperCase() === "ACTIVE" ? [subscription] : [],
  );
  await planStore.set(shop.id, projection.plan, projection.billingChargeId);
}

export async function reconcileShopSubscription(input: {
  shopId: string;
  shopDomain: string;
  shopifyAdmin: ShopifyAdmin;
  planStore: ShopPlanStore;
}): Promise<{ plan: BillingPlan; billingChargeId?: string }> {
  const projection = activeSubscriptionProjection(
    await input.shopifyAdmin.getActiveAppSubscriptions({
      shopDomain: input.shopDomain,
    }),
  );
  await input.planStore.set(
    input.shopId,
    projection.plan,
    projection.billingChargeId,
  );
  return projection;
}

let registered = false;

export function registerSubscriptionTopicHandler(): void {
  if (registered) return;
  registerTopicHandler(
    SHOPIFY_TOPICS.APP_SUBSCRIPTIONS_UPDATE,
    processSubscriptionUpdateEvent,
  );
  registered = true;
}
