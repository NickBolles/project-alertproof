const SHOPIFY_GID = /^gid:\/\/shopify\/([^/]+)\/(\d+)$/i;
const NUMERIC_ID = /^\d+$/;

/**
 * AlertProof stores Shopify legacy numeric IDs internally. REST webhooks
 * already use this shape; GraphQL adapters normalize GIDs at their boundary.
 */
export function canonicalShopifyResourceId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  return SHOPIFY_GID.exec(raw)?.[2] ?? raw;
}

export function canonicalOrderId(value: unknown): string | null {
  if (typeof value === "string") {
    const match = SHOPIFY_GID.exec(value.trim());
    if (match && match[1].toLowerCase() !== "order") return null;
  }
  return canonicalShopifyResourceId(value);
}

/** Convert the canonical internal order ID to Shopify Admin GraphQL's ID. */
export function shopifyOrderGid(value: unknown): string {
  const id = canonicalOrderId(value);
  if (!id || !NUMERIC_ID.test(id)) {
    throw new Error(`Invalid Shopify order id: ${String(value)}`);
  }
  return `gid://shopify/Order/${id}`;
}
