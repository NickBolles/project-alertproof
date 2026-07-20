import { randomUUID } from "node:crypto";
import type { BillingPlan, BillingService, ShopPlanStore } from "../../ports";

export class MockBillingService implements BillingService {
  readonly kind = "mock" as const;
  private readonly pending = new Map<string, Exclude<BillingPlan, "FREE">>();

  constructor(private readonly plans: ShopPlanStore) {}

  async getPlan(shopId: string): Promise<BillingPlan> {
    return (await this.plans.get(shopId)) ?? "FREE";
  }

  async requestSubscription(input: {
    shopId: string;
    plan: Exclude<BillingPlan, "FREE">;
    returnUrl: string;
  }): Promise<{ confirmationUrl: string }> {
    const confirmationId = `mock-charge-${randomUUID()}`;
    this.pending.set(`${input.shopId}:${confirmationId}`, input.plan);
    return {
      confirmationUrl: `${input.returnUrl}${input.returnUrl.includes("?") ? "&" : "?"}mock_confirmation_id=${confirmationId}`,
    };
  }

  async confirmSubscription(input: { shopId: string; confirmationId: string }) {
    const key = `${input.shopId}:${input.confirmationId}`;
    const plan = this.pending.get(key);
    if (!plan) throw new Error("Unknown mock billing confirmation");
    await this.plans.set(input.shopId, plan, input.confirmationId);
    this.pending.delete(key);
    return { plan, billingChargeId: input.confirmationId };
  }
}
