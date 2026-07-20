import { createHmac, randomUUID } from "node:crypto";

export function signedShopifyWebhook(input: {
  payload: Record<string, unknown>;
  topic: string;
  shopDomain?: string;
  webhookId?: string;
  secret?: string;
  validSignature?: boolean;
}): Request {
  const body = JSON.stringify(input.payload);
  const signature = createHmac("sha256", input.secret ?? "dev-secret")
    .update(body)
    .digest("base64");
  return new Request("http://localhost/webhooks/shopify", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Api-Version": "2026-07",
      "X-Shopify-Hmac-Sha256":
        input.validSignature === false ? "invalid" : signature,
      "X-Shopify-Shop-Domain": input.shopDomain ?? "fixture-shop.myshopify.com",
      "X-Shopify-Topic": input.topic,
      "X-Shopify-Webhook-Id": input.webhookId ?? randomUUID(),
    },
  });
}
