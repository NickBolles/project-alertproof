import type { ActionFunctionArgs } from "react-router";
import { createAdapters } from "../lib/adapters/index.server";
import { env } from "../lib/env.server";
import { handleProviderStatusWebhook } from "../lib/delivery/status.server";

export async function action({ request }: ActionFunctionArgs) {
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
  const adapter = isMockRequest
    ? adapters.channelFor("email", "mock://status")
    : adapters.email;
  try {
    const result = await handleProviderStatusWebhook({
      adapter,
      webhook: { body, headers },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 401 },
    );
  }
}
