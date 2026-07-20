import { timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { createAdapters } from "../lib/adapters/index.server";
import { handleProviderStatusWebhook } from "../lib/delivery/status.server";
import { env } from "../lib/env.server";

function mockAuthorized(headers: Readonly<Record<string, string>>): boolean {
  if (
    env.NODE_ENV === "production" ||
    env.SHOPIFY_API_KEY !== "dev-key" ||
    env.SHOPIFY_API_SECRET !== "dev-secret"
  ) {
    return false;
  }
  const supplied = headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!supplied) return false;
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(env.CRON_SECRET);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.text();
  const headers = Object.fromEntries(
    [...request.headers.entries()].map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  const adapters = createAdapters();
  const isJson = (headers["content-type"] ?? "").includes("application/json");
  const providerMessageId = isJson
    ? undefined
    : (new URLSearchParams(body).get("MessageSid") ?? undefined);
  const delivery = providerMessageId
    ? await prisma.delivery.findUnique({
        where: { providerMessageId },
        select: { destination: true, alert: { select: { shop: true } } },
      })
    : null;
  const useMock = isJson && mockAuthorized(headers);
  const adapter = useMock
    ? adapters.channelFor("sms", "mock://status")
    : delivery
      ? adapters.smsForShop(delivery.alert.shop.settings, delivery.destination)
      : adapters.sms;
  if (adapter.kind === "mock" && !useMock) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await handleProviderStatusWebhook({
      adapter,
      webhook: {
        body,
        headers,
        url: new URL("/webhooks/sms-status", env.SHOPIFY_APP_URL).toString(),
      },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 401 },
    );
  }
}
