import type { BillingPlan, BillingService, ShopPlanStore } from "../../ports";
import { NotConfiguredError } from "../errors";

/** Shopify-managed App Pricing adapter; no legacy recurring charges. */
export class ShopifyBillingService implements BillingService {
  readonly kind = "shopify" as const;

  constructor(
    private readonly plans: ShopPlanStore,
    private readonly pricingUrl?: string,
  ) {}

  async getPlan(shopId: string): Promise<BillingPlan> {
    return (await this.plans.get(shopId)) ?? "FREE";
  }

  async requestSubscription(input: {
    shopId: string;
    plan: Exclude<BillingPlan, "FREE">;
    returnUrl: string;
  }): Promise<{ confirmationUrl: string }> {
    if (!this.pricingUrl)
      throw new NotConfiguredError("SHOPIFY_APP_PRICING_URL");
    const url = new URL(this.pricingUrl);
    url.searchParams.set("plan", input.plan.toLowerCase());
    url.searchParams.set("return_url", input.returnUrl);
    return { confirmationUrl: url.toString() };
  }

  async confirmSubscription(input: {
    shopId: string;
    confirmationId: string;
  }): Promise<{ plan: BillingPlan; billingChargeId?: string }> {
    // Managed pricing has no client-trusted confirmation token. Never mutate
    // entitlements from a query string; return the server-side projection.
    return { plan: await this.getPlan(input.shopId) };
  }
}
