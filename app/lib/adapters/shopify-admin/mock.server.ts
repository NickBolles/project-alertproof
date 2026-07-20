import type { OrdersPage, ShopifyAdmin, ShopifyOrder } from "../../ports";

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

  constructor(
    fixtures: {
      orders?: Record<string, ShopifyOrder[]>;
      timezone?: string;
    } = {},
  ) {
    for (const [shop, orders] of Object.entries(fixtures.orders ?? {})) {
      this.orders.set(shop, structuredClone(orders));
    }
    this.timezone = fixtures.timezone ?? "UTC";
  }

  private readonly timezone: string;

  seedOrders(shopDomain: string, orders: ShopifyOrder[]): void {
    this.orders.set(shopDomain, structuredClone(orders));
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
}
