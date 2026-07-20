import { timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { env } from "../lib/env.server";
import {
  processPending,
  requeueDeadEvents,
} from "../lib/ingest/processor.server";
import { dispatchPendingDeliveries } from "../lib/delivery/dispatch.server";
import { reconcileAllShops } from "../lib/reconcile/reconcile.server";
import { processPendingWritebacks } from "../lib/writeback/order.server";

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
    await processPending();
    const delivery = await dispatchPendingDeliveries();
    const writeback = await processPendingWritebacks();
    return Response.json({ delivery, writeback });
  }
  if (params.job === "reconcile") {
    const reconciliation = await reconcileAllShops();
    let processed = 0;
    let result;
    do {
      result = await processPending();
      processed += result.processed;
    } while (result.claimed > 0);
    const delivery = await dispatchPendingDeliveries();
    const writeback = await processPendingWritebacks();
    return Response.json({ reconciliation, processed, delivery, writeback });
  }
  if (params.job === "requeue-dead") {
    return Response.json({ requeued: await requeueDeadEvents() });
  }
  return Response.json({ error: "Unknown cron job" }, { status: 404 });
}
