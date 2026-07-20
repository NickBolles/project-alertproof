import { createAdapters } from "../adapters/index.server";
import { env } from "../env.server";
import type { AlertChannelAdapter } from "../ports";
import {
  handleProviderStatusWebhook,
  ProviderWebhookAuthenticationError,
} from "./status.server";

export async function handleEmailStatusRequest(
  request: Request,
  adapterOverride?: AlertChannelAdapter,
) {
  const body = await request.text();
  const headers = Object.fromEntries(
    [...request.headers.entries()].map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  const adapters = createAdapters();
  const isMockRequest =
    env.NODE_ENV !== "production" &&
    env.SHOPIFY_API_KEY === "dev-key" &&
    /^Bearer\s+/i.test(headers.authorization ?? "");
  const adapter =
    adapterOverride ??
    (isMockRequest
      ? adapters.channelFor("email", "mock://status")
      : adapters.email);
  try {
    const result = await handleProviderStatusWebhook({
      adapter,
      webhook: { body, headers },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      {
        status: error instanceof ProviderWebhookAuthenticationError ? 401 : 400,
      },
    );
  }
}
