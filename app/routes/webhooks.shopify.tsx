import type { ActionFunctionArgs } from "react-router";
import { handleShopifyWebhook } from "../lib/ingest/webhook-action.server";

export async function action({ request }: ActionFunctionArgs) {
  return handleShopifyWebhook(request);
}
