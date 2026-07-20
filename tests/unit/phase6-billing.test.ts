import { Channel, Plan } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { MockBillingService } from "../../app/lib/adapters/billing/mock.server";
import { ShopifyBillingService } from "../../app/lib/adapters/billing/shopify.server";
import {
  channelAccessForPlan,
  effectivePlanForShop,
  isOverOrderLimit,
  PLAN_FEATURES,
  ruleCapacityForPlan,
} from "../../app/lib/billing/plans.server";
import { MemoryShopPlanStore } from "../helpers/memory";

describe("Phase 6 billing and entitlement matrix", () => {
  it("defines Free/$9/$19 in one plan table", () => {
    expect(PLAN_FEATURES.FREE).toMatchObject({
      monthlyPriceUsd: 0,
      maxRules: 1,
      channels: [Channel.EMAIL],
      retentionDays: 7,
      ordersPerMonth: 50,
    });
    expect(PLAN_FEATURES.STANDARD).toMatchObject({
      monthlyPriceUsd: 9,
      retentionDays: 90,
    });
    expect(PLAN_FEATURES.PRO).toMatchObject({
      monthlyPriceUsd: 19,
      escalation: true,
      digest: true,
      retentionDays: null,
    });
  });

  it("enforces rule, channel, and monthly order caps", () => {
    expect(ruleCapacityForPlan(Plan.FREE, 1)).toMatchObject({
      allowed: false,
      reason: "plan",
    });
    expect(ruleCapacityForPlan(Plan.STANDARD, 10_000)).toEqual({
      allowed: true,
    });
    expect(channelAccessForPlan(Plan.FREE, Channel.SLACK)).toEqual({
      allowed: false,
      reason: "plan",
    });
    expect(channelAccessForPlan(Plan.STANDARD, Channel.SMS)).toEqual({
      allowed: false,
      reason: "plan",
    });
    expect(channelAccessForPlan(Plan.PRO, Channel.SMS)).toEqual({
      allowed: true,
    });
    expect(isOverOrderLimit(Plan.FREE, 50)).toBe(false);
    expect(isOverOrderLimit(Plan.FREE, 51)).toBe(true);
  });

  it("grants Standard to a Free trial without capping a paid Pro plan", () => {
    const now = new Date("2026-07-20T12:00:00Z");
    expect(
      effectivePlanForShop(
        { plan: Plan.FREE, trialEndsAt: new Date("2026-07-21T12:00:00Z") },
        now,
      ),
    ).toBe(Plan.STANDARD);
    expect(
      effectivePlanForShop(
        { plan: Plan.FREE, trialEndsAt: new Date("2026-07-19T12:00:00Z") },
        now,
      ),
    ).toBe(Plan.FREE);
    expect(
      effectivePlanForShop(
        { plan: Plan.PRO, trialEndsAt: new Date("2026-07-21T12:00:00Z") },
        now,
      ),
    ).toBe(Plan.PRO);
  });

  it("activates mock upgrades instantly and generates managed-pricing redirects", async () => {
    const store = new MemoryShopPlanStore();
    const mock = new MockBillingService(store);
    await mock.requestSubscription({
      shopId: "shop",
      plan: "PRO",
      returnUrl: "https://app.test/app/billing",
    });
    expect(await mock.getPlan("shop")).toBe("PRO");
    const managed = new ShopifyBillingService(
      store,
      "https://admin.shopify.com/app-pricing",
    );
    await expect(
      managed.requestSubscription({
        shopId: "shop",
        plan: "STANDARD",
        returnUrl: "https://app.test/app/billing",
      }),
    ).resolves.toEqual({
      confirmationUrl:
        "https://admin.shopify.com/app-pricing?plan=standard&return_url=https%3A%2F%2Fapp.test%2Fapp%2Fbilling",
    });
  });
});
