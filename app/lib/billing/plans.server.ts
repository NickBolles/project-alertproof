import { Channel, Plan } from "@prisma/client";

export type PlanFeatures = {
  name: string;
  monthlyPriceUsd: number;
  maxRules: number | null;
  channels: readonly Channel[];
  retentionDays: number | null;
  ordersPerMonth: number | null;
  escalation: boolean;
  digest: boolean;
};

/** The sole source of truth for pricing and server-side entitlements. */
export const PLAN_FEATURES = {
  FREE: {
    name: "Free",
    monthlyPriceUsd: 0,
    maxRules: 1,
    channels: [Channel.EMAIL],
    retentionDays: 7,
    ordersPerMonth: 50,
    escalation: false,
    digest: false,
  },
  STANDARD: {
    name: "Standard",
    monthlyPriceUsd: 9,
    maxRules: null,
    channels: [Channel.EMAIL, Channel.SLACK, Channel.DISCORD],
    retentionDays: 90,
    ordersPerMonth: null,
    escalation: false,
    digest: false,
  },
  PRO: {
    name: "Pro",
    monthlyPriceUsd: 19,
    maxRules: null,
    channels: [Channel.EMAIL, Channel.SLACK, Channel.DISCORD, Channel.SMS],
    retentionDays: null,
    ordersPerMonth: null,
    escalation: true,
    digest: true,
  },
} as const satisfies Record<Plan, PlanFeatures>;

export type ShopPlanState = { plan: Plan; trialEndsAt: Date | null };

/** An active 14-day trial receives Standard entitlements without mutating billing state. */
export function effectivePlanForShop(
  shop: ShopPlanState,
  now = new Date(),
): Plan {
  return shop.trialEndsAt && shop.trialEndsAt > now ? Plan.STANDARD : shop.plan;
}

export function featuresForShop(
  shop: ShopPlanState,
  now = new Date(),
): PlanFeatures {
  return PLAN_FEATURES[effectivePlanForShop(shop, now)];
}

export function channelAccessForPlan(plan: Plan, channel: Channel) {
  return PLAN_FEATURES[plan].channels.includes(channel as never)
    ? ({ allowed: true } as const)
    : ({ allowed: false, reason: "plan" } as const);
}

export function ruleCapacityForPlan(plan: Plan, currentRules: number) {
  const max = PLAN_FEATURES[plan].maxRules;
  return max === null || currentRules < max
    ? ({ allowed: true } as const)
    : ({ allowed: false, reason: "plan", maxRules: max } as const);
}

export function isOverOrderLimit(plan: Plan, ordersProcessed: number): boolean {
  const limit = PLAN_FEATURES[plan].ordersPerMonth;
  return limit !== null && ordersProcessed > limit;
}
