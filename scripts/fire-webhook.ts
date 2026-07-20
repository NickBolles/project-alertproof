import "dotenv/config";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const [topic, fixturePath, suppliedWebhookId] = process.argv.slice(2);
if (!topic || !fixturePath) {
  console.error(
    "Usage: npm run fire-webhook -- <topic> <fixture.json> [webhook-id]",
  );
  process.exit(2);
}

const body = await readFile(resolve(fixturePath), "utf8");
JSON.parse(body);
const secret = process.env.SHOPIFY_API_SECRET ?? "dev-secret";
const appUrl = process.env.SHOPIFY_APP_URL ?? "http://localhost:3000";
const shopDomain =
  process.env.DEV_SHOP_DOMAIN ?? "alertproof-dev.myshopify.com";
const webhookId = suppliedWebhookId ?? randomUUID();
const hmac = createHmac("sha256", secret).update(body).digest("base64");

const response = await fetch(new URL("/webhooks/shopify", appUrl), {
  method: "POST",
  body,
  headers: {
    "Content-Type": "application/json",
    "X-Shopify-Api-Version": "2026-07",
    "X-Shopify-Hmac-Sha256": hmac,
    "X-Shopify-Shop-Domain": shopDomain,
    "X-Shopify-Topic": topic,
    "X-Shopify-Webhook-Id": webhookId,
  },
});

console.log(
  JSON.stringify({ status: response.status, topic, webhookId, shopDomain }),
);
if (!response.ok) process.exit(1);
