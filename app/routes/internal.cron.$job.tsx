import { timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { env } from "../lib/env.server";
import {
  processPending,
  requeueDeadEvents,
} from "../lib/ingest/processor.server";

function authorized(request: Request): boolean {
  const supplied = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");
  if (!supplied) return false;
  const expectedBuffer = Buffer.from(env.CRON_SECRET);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (!authorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (params.job === "dispatch") {
    return Response.json(await processPending());
  }
  if (params.job === "requeue-dead") {
    return Response.json({ requeued: await requeueDeadEvents() });
  }
  return Response.json({ error: "Unknown cron job" }, { status: 404 });
}
