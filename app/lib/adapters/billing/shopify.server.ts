import type { BillingPlan, BillingService } from "../../ports";
import { NotConfiguredError } from "../errors";

export class ShopifyBillingService implements BillingService {
  readonly kind = "shopify" as const;

  getPlan(_shopId: string): Promise<BillingPlan> {
    throw new NotConfiguredError("ShopifyBillingService");
  }

  requestSubscription(_input: {
    shopId: string;
    plan: Exclude<BillingPlan, "FREE">;
    returnUrl: string;
  }): Promise<{ confirmationUrl: string }> {
    throw new NotConfiguredError("ShopifyBillingService");
  }

  confirmSubscription(_input: {
    shopId: string;
    confirmationId: string;
  }): Promise<{ plan: BillingPlan; billingChargeId?: string }> {
    throw new NotConfiguredError("ShopifyBillingService");
  }
}
