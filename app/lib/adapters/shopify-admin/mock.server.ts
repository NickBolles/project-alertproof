import type {
  OrdersPage,
  ShopifyAdmin,
  ShopifyAppSubscription,
  ShopifyOrder,
} from "../../ports";
import {
  canonicalOrderId,
  canonicalShopifyResourceId,
} from "../../shopify/identity";

type MetafieldWrite = Parameters<ShopifyAdmin["writeOrderMetafield"]>[0];
type NoteWrite = Parameters<ShopifyAdmin["addOrderNote"]>[0];

export class MockShopifyAdmin implements ShopifyAdmin {
  readonly kind = "mock" as const;
  readonly metafieldWrites: MetafieldWrite[] = [];
  readonly noteWrites: NoteWrite[] = [];
  readonly orderQueries: Array<{
    shopDomain: string;
    updatedSince: Date;
    cursor?: string;
    limit?: number;
  }> = [];
  private readonly orders = new Map<string, ShopifyOrder[]>();
  private readonly products = new Map<
    string,
    { id: string; title: string; collectionIds: string[] }
  >();
  private readonly subscriptions = new Map<string, ShopifyAppSubscription[]>();

  constructor(
    fixtures: {
      orders?: Record<string, ShopifyOrder[]>;
      timezone?: string;
      subscriptions?: Record<string, ShopifyAppSubscription[]>;
    } = {},
  ) {
    for (const [shop, orders] of Object.entries(fixtures.orders ?? {})) {
      this.orders.set(
        shop,
        orders.map((order) => this.normalizeOrder(order)),
      );
    }
    for (const [shop, subscriptions] of Object.entries(
      fixtures.subscriptions ?? {},
    )) {
      this.subscriptions.set(shop, structuredClone(subscriptions));
    }
    this.timezone = fixtures.timezone ?? "UTC";
  }

  private readonly timezone: string;

  private normalizeOrder(order: ShopifyOrder): ShopifyOrder {
    const id = canonicalOrderId(order.id);
    if (!id) throw new Error(`Invalid Shopify order id: ${order.id}`);
    return {
      ...structuredClone(order),
      id,
      refunds: order.refunds.map((refund) => {
        const refundId = canonicalShopifyResourceId(refund.id);
        if (!refundId)
          throw new Error(`Invalid Shopify refund id: ${refund.id}`);
        return { ...structuredClone(refund), id: refundId };
      }),
    };
  }

  seedOrders(shopDomain: string, orders: ShopifyOrder[]): void {
    this.orders.set(
      shopDomain,
      orders.map((order) => this.normalizeOrder(order)),
    );
  }

  seedActiveAppSubscriptions(
    shopDomain: string,
    subscriptions: ShopifyAppSubscription[],
  ): void {
    this.subscriptions.set(shopDomain, structuredClone(subscriptions));
  }

  seedProduct(product: {
    id: string;
    title: string;
    collectionIds: string[];
  }): void {
    this.products.set(product.id, structuredClone(product));
  }

  async getOrdersUpdatedSince(input: {
    shopDomain: string;
    updatedSince: Date;
    cursor?: string;
    limit?: number;
  }): Promise<OrdersPage> {
    this.orderQueries.push(structuredClone(input));
    const offset = Number(input.cursor ?? 0);
    const limit = input.limit ?? 50;
    const matching = (this.orders.get(input.shopDomain) ?? [])
      .filter((order) => order.updatedAt >= input.updatedSince)
      .sort(
        (left, right) => left.updatedAt.getTime() - right.updatedAt.getTime(),
      );
    const orders = matching.slice(offset, offset + limit);
    const nextOffset = offset + orders.length;
    return {
      orders: structuredClone(orders),
      nextCursor: nextOffset < matching.length ? String(nextOffset) : undefined,
    };
  }

  async writeOrderMetafield(input: MetafieldWrite): Promise<void> {
    this.metafieldWrites.push(structuredClone(input));
  }

  async addOrderNote(input: NoteWrite): Promise<void> {
    this.noteWrites.push(structuredClone(input));
  }

  async getProduct(input: { shopDomain: string; productId: string }) {
    void input.shopDomain;
    return structuredClone(this.products.get(input.productId) ?? null);
  }

  async getShopTimezone(_shopDomain: string): Promise<string> {
    return this.timezone;
  }

  async getActiveAppSubscriptions(input: {
    shopDomain: string;
  }): Promise<ShopifyAppSubscription[]> {
    return structuredClone(this.subscriptions.get(input.shopDomain) ?? []);
  }
}
