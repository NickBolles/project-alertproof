import { env } from "../env.server";
import { registerRuleTopicHandlers } from "../rules/handlers.server";
import { dispatchPendingDeliveries } from "../delivery/dispatch.server";
import { reconcileAllShops } from "../reconcile/reconcile.server";
import { processPendingWritebacks } from "../writeback/order.server";
import { processPending } from "./processor.server";
import { escalateDueDeliveries } from "../escalation/escalate.server";
import { runDailyDigests } from "../digest/digest.server";
import { logger } from "../logger.server";
import { registerComplianceTopicHandlers } from "../compliance/gdpr.server";
import { runRetentionPrune } from "../retention/prune.server";
import { registerSubscriptionTopicHandler } from "../billing/subscriptions.server";

const WORKER_INTERVAL_MS = 2_000;
const RECONCILE_INTERVAL_MS = 15 * 60_000;
const ESCALATE_INTERVAL_MS = 60_000;
const DIGEST_INTERVAL_MS = 60 * 60_000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
const workerState = globalThis as typeof globalThis & {
  __alertProofWorkerTimer?: ReturnType<typeof setInterval>;
  __alertProofWorkerDrain?: Promise<void>;
  __alertProofReconcileTimer?: ReturnType<typeof setInterval>;
  __alertProofReconcileRun?: Promise<void>;
  __alertProofEscalateTimer?: ReturnType<typeof setInterval>;
  __alertProofEscalateRun?: Promise<void>;
  __alertProofDigestTimer?: ReturnType<typeof setInterval>;
  __alertProofDigestRun?: Promise<void>;
  __alertProofPruneTimer?: ReturnType<typeof setInterval>;
  __alertProofPruneRun?: Promise<void>;
};

registerRuleTopicHandlers();
registerComplianceTopicHandlers();
registerSubscriptionTopicHandler();

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
      logger.error("worker.drain_failed", { error });
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
      .catch((error) => logger.error("worker.reconcile_failed", { error }))
      .finally(() => {
        workerState.__alertProofReconcileRun = undefined;
      });
  }, RECONCILE_INTERVAL_MS);
  workerState.__alertProofReconcileTimer.unref?.();
  workerState.__alertProofEscalateTimer ??= setInterval(() => {
    if (workerState.__alertProofEscalateRun) return;
    workerState.__alertProofEscalateRun = escalateDueDeliveries()
      .then(() => dispatchPendingDeliveries())
      .then(() => undefined)
      .catch((error) => logger.error("worker.escalation_failed", { error }))
      .finally(() => {
        workerState.__alertProofEscalateRun = undefined;
      });
  }, ESCALATE_INTERVAL_MS);
  workerState.__alertProofEscalateTimer.unref?.();
  workerState.__alertProofDigestTimer ??= setInterval(() => {
    if (workerState.__alertProofDigestRun) return;
    workerState.__alertProofDigestRun = runDailyDigests()
      .then(() => dispatchPendingDeliveries())
      .then(() => undefined)
      .catch((error) => logger.error("worker.digest_failed", { error }))
      .finally(() => {
        workerState.__alertProofDigestRun = undefined;
      });
  }, DIGEST_INTERVAL_MS);
  workerState.__alertProofDigestTimer.unref?.();
  workerState.__alertProofPruneTimer ??= setInterval(() => {
    if (workerState.__alertProofPruneRun) return;
    workerState.__alertProofPruneRun = runRetentionPrune()
      .then(() => undefined)
      .catch((error) => logger.error("worker.prune_failed", { error }))
      .finally(() => {
        workerState.__alertProofPruneRun = undefined;
      });
  }, PRUNE_INTERVAL_MS);
  workerState.__alertProofPruneTimer.unref?.();
  void escalateDueDeliveries()
    .then(() => dispatchPendingDeliveries())
    .catch((error) =>
      logger.error("worker.escalation_start_failed", { error }),
    );
  void runDailyDigests()
    .then(() => dispatchPendingDeliveries())
    .catch((error) => logger.error("worker.digest_start_failed", { error }));
  kickWebhookWorker();
}
