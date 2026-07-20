import type {
  BillingPlan,
  MockOutboxRecord,
  OutboxWriter,
  ShopPlanStore,
} from "../../app/lib/ports";

export class MemoryOutbox implements OutboxWriter {
  readonly records: MockOutboxRecord[] = [];

  async write(record: MockOutboxRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

export class MemoryShopPlanStore implements ShopPlanStore {
  readonly plans = new Map<
    string,
    { plan: BillingPlan; billingChargeId?: string }
  >();

  async get(shopId: string): Promise<BillingPlan | null> {
    return this.plans.get(shopId)?.plan ?? null;
  }

  async set(
    shopId: string,
    plan: BillingPlan,
    billingChargeId?: string,
  ): Promise<void> {
    this.plans.set(shopId, { plan, billingChargeId });
  }
}
