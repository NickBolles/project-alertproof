ALTER TABLE "Delivery" ADD COLUMN "messageKey" TEXT;
ALTER TABLE "Delivery" ADD COLUMN "destination" TEXT;
ALTER TABLE "Delivery" ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "Delivery" AS delivery
SET "messageKey" = alert."dedupeKey",
    "destination" = CASE delivery."channel"
      WHEN 'EMAIL'::"Channel" THEN COALESCE(recipient."email", 'unconfigured:' || recipient."id")
      WHEN 'SLACK'::"Channel" THEN COALESCE(recipient."slackWebhookUrlEnc", 'unconfigured:' || recipient."id")
      WHEN 'DISCORD'::"Channel" THEN COALESCE(recipient."discordWebhookUrlEnc", 'unconfigured:' || recipient."id")
      WHEN 'SMS'::"Channel" THEN COALESCE(recipient."phoneE164", 'unconfigured:' || recipient."id")
    END
FROM "Alert" AS alert, "Recipient" AS recipient
WHERE delivery."alertId" = alert."id"
  AND delivery."recipientId" = recipient."id";

ALTER TABLE "Delivery" ALTER COLUMN "messageKey" SET NOT NULL;
ALTER TABLE "Delivery" ALTER COLUMN "destination" SET NOT NULL;

CREATE UNIQUE INDEX "Delivery_messageKey_channel_destination_key"
  ON "Delivery"("messageKey", "channel", "destination");
CREATE INDEX "Delivery_status_nextAttemptAt_idx"
  ON "Delivery"("status", "nextAttemptAt");

ALTER TABLE "Delivery" DROP CONSTRAINT "Delivery_recipientId_fkey";
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_recipientId_fkey"
  FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
