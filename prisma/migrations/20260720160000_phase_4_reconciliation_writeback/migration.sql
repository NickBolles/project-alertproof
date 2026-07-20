ALTER TABLE "WebhookEvent" ADD COLUMN "resourceId" TEXT;
UPDATE "WebhookEvent"
SET "resourceId" = CASE
  WHEN topic IN ('refunds/create', 'order_transactions/create')
    THEN payload->>'id'
  ELSE "orderId"
END;
CREATE INDEX "WebhookEvent_shopDomain_topic_orderId_resourceId_idx"
  ON "WebhookEvent"("shopDomain", topic, "orderId", "resourceId");

ALTER TABLE "Alert" ADD COLUMN "writebackPending" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Alert" ADD COLUMN "writebackAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Alert" ADD COLUMN "writebackNextAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Alert" ADD COLUMN "writebackAt" TIMESTAMP(3);
ALTER TABLE "Alert" ADD COLUMN "writebackError" TEXT;
CREATE INDEX "Alert_writebackPending_writebackNextAt_idx"
  ON "Alert"("writebackPending", "writebackNextAt");
