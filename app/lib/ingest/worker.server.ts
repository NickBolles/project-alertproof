import { env } from "../env.server";
import { registerRuleTopicHandlers } from "../rules/handlers.server";
import { dispatchPendingDeliveries } from "../delivery/dispatch.server";
import { reconcileAllShops } from "../reconcile/reconcile.server";
import { processPendingWritebacks } from "../writeback/order.server";
import { processPending } from "./processor.server";

const WORKER_INTERVAL_MS = 2_000;
const RECONCILE_INTERVAL_MS = 15 * 60_000;
const workerState = globalThis as typeof globalThis & {
  __alertProofWorkerTimer?: ReturnType<typeof setInterval>;
  __alertProofWorkerDrain?: Promise<void>;
  __alertProofReconcileTimer?: ReturnType<typeof setInterval>;
  __alertProofReconcileRun?: Promise<void>;
};

registerRuleTopicHandlers();

export async function drainWebhookQueue(): Promise<void> {
  if (workerState.__alertProofWorkerDrain) {
    return workerState.__alertProofWorkerDrain;
  }
  workerState.__alertProofWorkerDrain = (async () => {
    try {
      let result;
      do {
        result = await processPending();
      } while (result.claimed > 0);
      await dispatchPendingDeliveries();
      await processPendingWritebacks();
    } catch (error) {
      console.error("Webhook worker drain failed", error);
    } finally {
      workerState.__alertProofWorkerDrain = undefined;
    }
  })();
  return workerState.__alertProofWorkerDrain;
}

export function kickWebhookWorker(): void {
  queueMicrotask(() => void drainWebhookQueue());
}

export function startWebhookWorker(): void {
  if (env.DISABLE_WORKER || workerState.__alertProofWorkerTimer) return;
  workerState.__alertProofWorkerTimer = setInterval(
    () => void drainWebhookQueue(),
    WORKER_INTERVAL_MS,
  );
  workerState.__alertProofWorkerTimer.unref?.();
  workerState.__alertProofReconcileTimer ??= setInterval(() => {
    if (workerState.__alertProofReconcileRun) return;
    workerState.__alertProofReconcileRun = reconcileAllShops()
      .then(() => kickWebhookWorker())
      .catch((error) => console.error("Reconciliation interval failed", error))
      .finally(() => {
        workerState.__alertProofReconcileRun = undefined;
      });
  }, RECONCILE_INTERVAL_MS);
  workerState.__alertProofReconcileTimer.unref?.();
  kickWebhookWorker();
}
