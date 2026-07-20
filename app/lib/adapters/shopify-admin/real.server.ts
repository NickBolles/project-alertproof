import type { OrdersPage, ShopifyAdmin, ShopifyOrder } from "../../ports";

type GraphqlBody<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

function assertGraphql<T>(body: GraphqlBody<T>): T {
  if (!body.data || body.errors?.length) {
    throw new Error(
      `Shopify Admin GraphQL failed: ${body.errors?.map((error) => error.message).join("; ") ?? "missing data"}`,
    );
  }
  return body.data;
}

function assertNoUserErrors(
  errors: Array<{ field?: string[] | null; message: string }>,
): void {
  if (errors.length > 0) {
    throw new Error(
      `Shopify mutation failed: ${errors.map((error) => error.message).join("; ")}`,
    );
  }
}

export class RealShopifyAdmin implements ShopifyAdmin {
  readonly kind = "shopify" as const;

  private async graphql<T>(
    shopDomain: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    // Dynamic import avoids a startup cycle: shopify.server creates the adapter factory.
    const { unauthenticated } = await import("../../../shopify.server");
    const { admin } = await unauthenticated.admin(shopDomain);
    const response = await admin.graphql(query, { variables });
    return assertGraphql((await response.json()) as GraphqlBody<T>);
  }

  async getOrdersUpdatedSince(input: {
    shopDomain: string;
    updatedSince: Date;
    cursor?: string;
    limit?: number;
  }): Promise<OrdersPage> {
    type OrderNode = {
      id: string;
      name: string;
      createdAt: string;
      updatedAt: string;
      displayFinancialStatus?: string | null;
      currentTotalPriceSet?: { shopMoney: { amount: string } } | null;
      refunds: { nodes: Array<{ id: string; createdAt: string }> };
      lineItems: {
        nodes: Array<{
          title: string;
          product?: { id: string } | null;
          variant?: { id: string } | null;
        }>;
      };
    };
    const data = await this.graphql<{
      orders: {
        nodes: OrderNode[];
        pageInfo: { hasNextPage: boolean; endCursor?: string | null };
      };
    }>(
      input.shopDomain,
      `#graphql
        query ReconcileOrders($first: Int!, $after: String, $query: String!) {
          orders(first: $first, after: $after, sortKey: UPDATED_AT, query: $query) {
            nodes {
              id name createdAt updatedAt displayFinancialStatus
              currentTotalPriceSet { shopMoney { amount } }
              refunds(first: 250) { nodes { id createdAt } }
              lineItems(first: 100) {
                nodes { title product { id } variant { id } }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
      {
        first: Math.min(250, Math.max(1, input.limit ?? 50)),
        after: input.cursor,
        query: `updated_at:>=${input.updatedSince.toISOString()}`,
      },
    );
    const orders: ShopifyOrder[] = data.orders.nodes.map((order) => ({
      id: order.id,
      name: order.name,
      createdAt: new Date(order.createdAt),
      updatedAt: new Date(order.updatedAt),
      financialStatus: order.displayFinancialStatus?.toLowerCase(),
      totalPrice: order.currentTotalPriceSet?.shopMoney.amount,
      refunds: order.refunds.nodes.map((refund) => ({
        id: refund.id,
        createdAt: new Date(refund.createdAt),
      })),
      lineItems: order.lineItems.nodes.map((item) => ({
        productId: item.product?.id,
        variantId: item.variant?.id,
        title: item.title,
      })),
    }));
    return {
      orders,
      nextCursor: data.orders.pageInfo.hasNextPage
        ? (data.orders.pageInfo.endCursor ?? undefined)
        : undefined,
    };
  }

  async writeOrderMetafield(input: {
    shopDomain: string;
    orderId: string;
    namespace: string;
    key: string;
    value: string;
  }): Promise<void> {
    const data = await this.graphql<{
      metafieldsSet: {
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(
      input.shopDomain,
      `#graphql
        mutation AlertProofMetafield($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors { field message }
          }
        }
      `,
      {
        metafields: [
          {
            ownerId: input.orderId,
            namespace: input.namespace,
            key: input.key,
            type: "json",
            value: input.value,
          },
        ],
      },
    );
    assertNoUserErrors(data.metafieldsSet.userErrors);
  }

  async addOrderNote(input: {
    shopDomain: string;
    orderId: string;
    note: string;
  }): Promise<void> {
    const current = await this.graphql<{
      order: { note?: string | null } | null;
    }>(
      input.shopDomain,
      `#graphql query AlertProofOrderNote($id: ID!) { order(id: $id) { note } }`,
      { id: input.orderId },
    );
    if (!current.order)
      throw new Error(`Shopify order not found: ${input.orderId}`);
    if (current.order.note?.split(/\r?\n/).includes(input.note)) return;
    const note = [current.order.note?.trim(), input.note]
      .filter(Boolean)
      .join("\n");
    const data = await this.graphql<{
      orderUpdate: {
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(
      input.shopDomain,
      `#graphql
        mutation AlertProofOrderNote($input: OrderInput!) {
          orderUpdate(input: $input) { userErrors { field message } }
        }
      `,
      { input: { id: input.orderId, note } },
    );
    assertNoUserErrors(data.orderUpdate.userErrors);
  }

  async getProduct(input: { shopDomain: string; productId: string }): Promise<{
    id: string;
    title: string;
    collectionIds: string[];
  } | null> {
    const data = await this.graphql<{
      product: {
        id: string;
        title: string;
        collections: { nodes: Array<{ id: string }> };
      } | null;
    }>(
      input.shopDomain,
      `#graphql
        query AlertProofProduct($id: ID!) {
          product(id: $id) { id title collections(first: 100) { nodes { id } } }
        }
      `,
      { id: input.productId },
    );
    return data.product
      ? {
          id: data.product.id,
          title: data.product.title,
          collectionIds: data.product.collections.nodes.map((node) => node.id),
        }
      : null;
  }

  async getShopTimezone(shopDomain: string): Promise<string> {
    const data = await this.graphql<{ shop: { ianaTimezone: string } }>(
      shopDomain,
      `#graphql query AlertProofShopTimezone { shop { ianaTimezone } }`,
    );
    return data.shop.ianaTimezone;
  }
}
