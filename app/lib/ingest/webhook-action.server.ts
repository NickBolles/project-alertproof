import { authenticate } from "../../shopify.server";
import { enqueueWebhook } from "./enqueue.server";
import { kickWebhookWorker } from "./worker.server";
import { logger } from "../logger.server";

type WebhookAuthentication = Pick<
  Awaited<ReturnType<typeof authenticate.webhook>>,
  "payload" | "shop" | "topic" | "webhookId"
>;

export type WebhookActionDependencies = {
  authenticateWebhook(request: Request): Promise<WebhookAuthentication>;
  enqueue: typeof enqueueWebhook;
  kick(): void;
  now(): number;
  logLatency(
    milliseconds: number,
    context?: { webhookId: string; shop: string; topic: string },
  ): void;
};

const dependencies: WebhookActionDependencies = {
  authenticateWebhook: authenticate.webhook,
  enqueue: enqueueWebhook,
  kick: kickWebhookWorker,
  now: () => performance.now(),
  logLatency: (milliseconds, context) =>
    logger.info("webhook.persisted", {
      acknowledgementMilliseconds: Math.round(milliseconds * 100) / 100,
      ...context,
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
  const resolvedWebhookId =
    webhookId || request.headers.get("X-Shopify-Webhook-Id") || "";
  await deps.enqueue({
    shopDomain: shop,
    topic: String(topic),
    shopifyWebhookId: resolvedWebhookId,
    payload,
  });
  deps.kick();
  deps.logLatency(deps.now() - startedAt, {
    webhookId: resolvedWebhookId,
    shop,
    topic: String(topic),
  });
  return new Response(null, { status: 200 });
}
