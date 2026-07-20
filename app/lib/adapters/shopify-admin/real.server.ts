import type { OrdersPage, ShopifyAdmin } from "../../ports";
import { NotConfiguredError } from "../errors";

export class RealShopifyAdmin implements ShopifyAdmin {
  readonly kind = "shopify" as const;

  getOrdersUpdatedSince(_input: {
    shopDomain: string;
    updatedSince: Date;
    cursor?: string;
    limit?: number;
  }): Promise<OrdersPage> {
    throw new NotConfiguredError("RealShopifyAdmin");
  }

  writeOrderMetafield(_input: {
    shopDomain: string;
    orderId: string;
    namespace: string;
    key: string;
    value: string;
  }): Promise<void> {
    throw new NotConfiguredError("RealShopifyAdmin");
  }

  addOrderNote(_input: {
    shopDomain: string;
    orderId: string;
    note: string;
  }): Promise<void> {
    throw new NotConfiguredError("RealShopifyAdmin");
  }

  getProduct(_input: { shopDomain: string; productId: string }): Promise<{
    id: string;
    title: string;
    collectionIds: string[];
  } | null> {
    throw new NotConfiguredError("RealShopifyAdmin");
  }

  getShopTimezone(_shopDomain: string): Promise<string> {
    throw new NotConfiguredError("RealShopifyAdmin");
  }
}
