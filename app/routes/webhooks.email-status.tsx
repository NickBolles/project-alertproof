import type { ActionFunctionArgs } from "react-router";
import { handleEmailStatusRequest } from "../lib/delivery/email-status-route.server";

export async function action({ request }: ActionFunctionArgs) {
  return handleEmailStatusRequest(request);
}
