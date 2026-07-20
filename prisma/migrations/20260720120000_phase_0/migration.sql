CREATE TYPE "Plan" AS ENUM ('FREE', 'STANDARD', 'PRO');
CREATE TYPE "EventSource" AS ENUM ('WEBHOOK', 'RECONCILIATION', 'TEST');
CREATE TYPE "EventStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD');
CREATE TYPE "Trigger" AS ENUM ('ORDER_CREATED', 'ORDER_PAID', 'ORDER_VALUE_GTE', 'PRODUCT_ORDERED', 'LOW_STOCK', 'REFUND_CREATED', 'PAYMENT_FAILED');
CREATE TYPE "Channel" AS ENUM ('EMAIL', 'SLACK', 'DISCORD', 'SMS');
CREATE TYPE "AlertKind" AS ENUM ('RULE', 'DIGEST');
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'DELIVERED', 'BOUNCED', 'DEFERRED', 'FAILED', 'SKIPPED');

CREATE TABLE "Session" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "isOnline" BOOLEAN NOT NULL DEFAULT false,
  "scope" TEXT,
  "expires" TIMESTAMP(3),
  "accessToken" TEXT NOT NULL,
  "userId" BIGINT,
  "firstName" TEXT,
  "lastName" TEXT,
  "email" TEXT,
  "accountOwner" BOOLEAN NOT NULL DEFAULT false,
  "locale" TEXT,
  "collaborator" BOOLEAN DEFAULT false,
  "emailVerified" BOOLEAN DEFAULT false,
  "refreshToken" TEXT,
  "refreshTokenExpires" TIMESTAMP(3),
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Shop" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "plan" "Plan" NOT NULL DEFAULT 'FREE',
  "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "trialEndsAt" TIMESTAMP(3),
  "billingChargeId" TEXT,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "reconcileCursor" TIMESTAMP(3),
  "settings" JSONB NOT NULL DEFAULT '{}',
  "uninstalledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebhookEvent" (
  "id" TEXT NOT NULL,
  "shopDomain" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "shopifyWebhookId" TEXT NOT NULL,
  "source" "EventSource" NOT NULL DEFAULT 'WEBHOOK',
  "orderId" TEXT,
  "payload" JSONB,
  "status" "EventStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Rule" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "trigger" "Trigger" NOT NULL,
  "conditions" JSONB NOT NULL DEFAULT '{}',
  "escalation" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Recipient" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT,
  "slackWebhookUrlEnc" TEXT,
  "discordWebhookUrlEnc" TEXT,
  "phoneE164" TEXT,
  "digestEnabled" BOOLEAN NOT NULL DEFAULT false,
  "digestHourLocal" INTEGER NOT NULL DEFAULT 8,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Recipient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RuleRecipient" (
  "ruleId" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "channels" "Channel"[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RuleRecipient_pkey" PRIMARY KEY ("ruleId", "recipientId")
);

CREATE TABLE "Alert" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "kind" "AlertKind" NOT NULL DEFAULT 'RULE',
  "ruleId" TEXT,
  "webhookEventId" TEXT,
  "dedupeKey" TEXT NOT NULL,
  "orderId" TEXT,
  "orderName" TEXT,
  "orderValue" DECIMAL(18,2),
  "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Delivery" (
  "id" TEXT NOT NULL,
  "alertId" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "channel" "Channel" NOT NULL,
  "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "providerMessageId" TEXT,
  "providerDetail" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "isEscalation" BOOLEAN NOT NULL DEFAULT false,
  "escalatedFromId" TEXT,
  "sentAt" TIMESTAMP(3),
  "statusAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InventoryState" (
  "shopId" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "lastAvailable" INTEGER NOT NULL,
  "epoch" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InventoryState_pkey" PRIMARY KEY ("shopId", "inventoryItemId", "locationId")
);

CREATE TABLE "ProviderEvent" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerMessageId" TEXT,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReconciliationRun" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "cursor" TIMESTAMP(3) NOT NULL,
  "ordersChecked" INTEGER NOT NULL DEFAULT 0,
  "missedFound" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UsageCounter" (
  "shopId" TEXT NOT NULL,
  "periodYYYYMM" TEXT NOT NULL,
  "ordersProcessed" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("shopId", "periodYYYYMM")
);

CREATE TABLE "MockOutbox" (
  "id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "to" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "deliveryId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MockOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");
CREATE UNIQUE INDEX "WebhookEvent_shopifyWebhookId_key" ON "WebhookEvent"("shopifyWebhookId");
CREATE INDEX "WebhookEvent_status_nextAttemptAt_idx" ON "WebhookEvent"("status", "nextAttemptAt");
CREATE INDEX "WebhookEvent_shopDomain_topic_orderId_idx" ON "WebhookEvent"("shopDomain", "topic", "orderId");
CREATE INDEX "WebhookEvent_shopDomain_topic_receivedAt_idx" ON "WebhookEvent"("shopDomain", "topic", "receivedAt");
CREATE INDEX "Rule_shopId_idx" ON "Rule"("shopId");
CREATE INDEX "Recipient_shopId_idx" ON "Recipient"("shopId");
CREATE INDEX "RuleRecipient_recipientId_idx" ON "RuleRecipient"("recipientId");
CREATE UNIQUE INDEX "Alert_webhookEventId_ruleId_key" ON "Alert"("webhookEventId", "ruleId");
CREATE UNIQUE INDEX "Alert_shopId_dedupeKey_key" ON "Alert"("shopId", "dedupeKey");
CREATE INDEX "Alert_shopId_orderId_idx" ON "Alert"("shopId", "orderId");
CREATE INDEX "Alert_ruleId_idx" ON "Alert"("ruleId");
CREATE UNIQUE INDEX "Delivery_providerMessageId_key" ON "Delivery"("providerMessageId");
CREATE UNIQUE INDEX "Delivery_escalatedFromId_key" ON "Delivery"("escalatedFromId");
CREATE INDEX "Delivery_status_sentAt_idx" ON "Delivery"("status", "sentAt");
CREATE INDEX "Delivery_alertId_idx" ON "Delivery"("alertId");
CREATE INDEX "Delivery_recipientId_idx" ON "Delivery"("recipientId");
CREATE INDEX "ProviderEvent_providerMessageId_idx" ON "ProviderEvent"("providerMessageId");
CREATE INDEX "ReconciliationRun_shopId_startedAt_idx" ON "ReconciliationRun"("shopId", "startedAt");
CREATE INDEX "MockOutbox_createdAt_idx" ON "MockOutbox"("createdAt");

ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop"("shopDomain") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Recipient" ADD CONSTRAINT "Recipient_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RuleRecipient" ADD CONSTRAINT "RuleRecipient_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RuleRecipient" ADD CONSTRAINT "RuleRecipient_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_webhookEventId_fkey" FOREIGN KEY ("webhookEventId") REFERENCES "WebhookEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_escalatedFromId_fkey" FOREIGN KEY ("escalatedFromId") REFERENCES "Delivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InventoryState" ADD CONSTRAINT "InventoryState_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReconciliationRun" ADD CONSTRAINT "ReconciliationRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
