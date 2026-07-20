import { authenticate } from "../../shopify.server";
import { enqueueWebhook } from "./enqueue.server";
import { kickWebhookWorker } from "./worker.server";

type WebhookAuthentication = Pick<
  Awaited<ReturnType<typeof authenticate.webhook>>,
  "payload" | "shop" | "topic" | "webhookId"
>;

export type WebhookActionDependencies = {
  authenticateWebhook(request: Request): Promise<WebhookAuthentication>;
  enqueue: typeof enqueueWebhook;
  kick(): void;
  now(): number;
  logLatency(milliseconds: number): void;
};

const dependencies: WebhookActionDependencies = {
  authenticateWebhook: authenticate.webhook,
  enqueue: enqueueWebhook,
  kick: kickWebhookWorker,
  now: () => performance.now(),
  logLatency: (milliseconds) =>
    console.info("Shopify webhook persisted", {
      acknowledgementMilliseconds: Math.round(milliseconds * 100) / 100,
    }),
};

export async function handleShopifyWebhook(
  request: Request,
  overrides: Partial<WebhookActionDependencies> = {},
): Promise<Response> {
  const deps = { ...dependencies, ...overrides };
  const startedAt = deps.now();
  const { payload, shop, topic, webhookId } =
    await deps.authenticateWebhook(request);
  await deps.enqueue({
    shopDomain: shop,
    topic: String(topic),
    shopifyWebhookId:
      webhookId || request.headers.get("X-Shopify-Webhook-Id") || "",
    payload,
  });
  deps.kick();
  deps.logLatency(deps.now() - startedAt);
  return new Response(null, { status: 200 });
}
