import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { createAdapters } from "../lib/adapters/index.server";
import { env } from "../lib/env.server";
import { handleProviderStatusWebhook } from "../lib/delivery/status.server";

function enabled(request: Request): boolean {
  if (
    env.NODE_ENV === "production" ||
    !env.ALERTPROOF_AUTH_BYPASS ||
    env.SHOPIFY_API_KEY !== "dev-key" ||
    env.SHOPIFY_API_SECRET !== "dev-secret"
  ) {
    return false;
  }
  return request.headers.get("authorization") === `Bearer ${env.CRON_SECRET}`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (!enabled(request)) return new Response("Not found", { status: 404 });
  return Response.json({
    outbox: await prisma.mockOutbox.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (!enabled(request)) return new Response("Not found", { status: 404 });
  const form = await request.formData();
  const providerMessageId = String(form.get("providerMessageId") ?? "");
  const status = String(form.get("status") ?? "delivered");
  if (
    !providerMessageId ||
    !["delivered", "bounced", "deferred"].includes(status)
  ) {
    return Response.json(
      { error: "Invalid mock status request" },
      { status: 400 },
    );
  }
  const adapter = createAdapters().channelFor("email", "mock://status");
  const result = await handleProviderStatusWebhook({
    adapter,
    webhook: {
      headers: { authorization: `Bearer ${env.CRON_SECRET}` },
      body: JSON.stringify({ providerMessageId, status }),
    },
  });
  return Response.json(result);
}
