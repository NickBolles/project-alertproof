import {
  EventStatus,
  Prisma,
  type PrismaClient,
  type WebhookEvent,
} from "@prisma/client";
import prisma from "../../db.server";
import { canonicalizeTopic, SHOPIFY_TOPICS } from "./topics";
import { logger } from "../logger.server";

export const MAX_WEBHOOK_ATTEMPTS = 15;
export const PROCESSING_LEASE_MS = 10 * 60 * 1_000;
export const DEFAULT_BATCH_SIZE = 25;

export type ProcessableWebhookEvent = Omit<WebhookEvent, "payload"> & {
  payload: Prisma.JsonValue | null;
};

export type TopicHandler = (
  event: ProcessableWebhookEvent,
  context: { prisma: PrismaClient },
) => Promise<void>;

const handlers = new Map<string, TopicHandler>();

function databaseTimestamp(value: Date): Prisma.Sql {
  // Prisma stores DateTime in PostgreSQL's timestamp-without-time-zone as UTC.
  // Passing an explicit timestamp literal keeps comparisons independent of the
  // database session timezone.
  return Prisma.sql`${value.toISOString().replace(/Z$/, "")}::timestamp`;
}

export function registerTopicHandler(
  topic: string,
  handler: TopicHandler,
): () => void {
  const key = canonicalizeTopic(topic);
  handlers.set(key, handler);
  return () => {
    if (handlers.get(key) === handler) handlers.delete(key);
  };
}

export function retryBackoffSeconds(attemptsBeforeFailure: number): number {
  return Math.min(30 * 2 ** Math.max(0, attemptsBeforeFailure), 3_600);
}

async function defaultTopicHandler(
  event: ProcessableWebhookEvent,
  context: { prisma: PrismaClient },
): Promise<void> {
  if (event.topic !== SHOPIFY_TOPICS.APP_UNINSTALLED) return;
  await context.prisma.$transaction([
    context.prisma.shop.updateMany({
      where: { shopDomain: event.shopDomain },
      data: { uninstalledAt: new Date() },
    }),
    context.prisma.rule.updateMany({
      where: { shop: { shopDomain: event.shopDomain } },
      data: { enabled: false },
    }),
  ]);
}

export async function claimPendingEvents(
  input: {
    client?: PrismaClient;
    now?: Date;
    batchSize?: number;
  } = {},
): Promise<ProcessableWebhookEvent[]> {
  const client = input.client ?? prisma;
  const now = input.now ?? new Date();
  const nowSql = databaseTimestamp(now);
  const batchSize = Math.max(1, input.batchSize ?? DEFAULT_BATCH_SIZE);

  return client.$transaction((tx) =>
    tx.$queryRaw<ProcessableWebhookEvent[]>(Prisma.sql`
      WITH candidates AS (
        SELECT id
        FROM "WebhookEvent"
        WHERE status IN ('PENDING'::"EventStatus", 'FAILED'::"EventStatus")
          AND "nextAttemptAt" <= ${nowSql}
        ORDER BY "receivedAt", id
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchSize}
      )
      UPDATE "WebhookEvent" AS event
      SET status = 'PROCESSING'::"EventStatus", "updatedAt" = ${nowSql}
      FROM candidates
      WHERE event.id = candidates.id
      RETURNING event.*
    `),
  );
}

export async function reclaimStuckProcessing(
  input: {
    client?: PrismaClient;
    now?: Date;
  } = {},
): Promise<{ reclaimed: number; dead: number }> {
  const client = input.client ?? prisma;
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - PROCESSING_LEASE_MS);
  const nowSql = databaseTimestamp(now);
  const cutoffSql = databaseTimestamp(cutoff);
  const rows = await client.$queryRaw<
    Array<{ status: EventStatus }>
  >(Prisma.sql`
    UPDATE "WebhookEvent"
    SET attempts = attempts + 1,
        status = CASE
          WHEN attempts + 1 >= ${MAX_WEBHOOK_ATTEMPTS}
            THEN 'DEAD'::"EventStatus"
          ELSE 'FAILED'::"EventStatus"
        END,
        "nextAttemptAt" = CASE
          WHEN attempts + 1 >= ${MAX_WEBHOOK_ATTEMPTS} THEN ${nowSql}
          ELSE ${nowSql} + make_interval(
            secs => LEAST(30 * power(2, attempts), 3600)::integer
          )
        END,
        "lastError" = 'Processing lease expired before completion',
        "updatedAt" = ${nowSql}
    WHERE status = 'PROCESSING'::"EventStatus"
      AND "updatedAt" < ${cutoffSql}
    RETURNING status
  `);
  return {
    reclaimed: rows.length,
    dead: rows.filter((row) => row.status === EventStatus.DEAD).length,
  };
}

export async function processPending(
  input: {
    client?: PrismaClient;
    now?: Date;
    batchSize?: number;
    topicHandlers?: ReadonlyMap<string, TopicHandler>;
    reclaim?: boolean;
  } = {},
): Promise<{
  claimed: number;
  processed: number;
  failed: number;
  dead: number;
  reclaimed: number;
}> {
  const client = input.client ?? prisma;
  const now = input.now ?? new Date();
  const reclaimed =
    input.reclaim === false
      ? { reclaimed: 0, dead: 0 }
      : await reclaimStuckProcessing({ client, now });
  const events = await claimPendingEvents({
    client,
    now,
    batchSize: input.batchSize,
  });
  let processed = 0;
  let failed = 0;
  let dead = reclaimed.dead;

  for (const event of events) {
    logger.info("webhook.claimed", {
      eventId: event.id,
      webhookId: event.shopifyWebhookId,
      topic: event.topic,
      attempt: event.attempts + 1,
    });
    const handler =
      input.topicHandlers?.get(event.topic) ??
      handlers.get(event.topic) ??
      defaultTopicHandler;
    try {
      await handler(event, { prisma: client });
      const result = await client.webhookEvent.updateMany({
        where: { id: event.id, status: EventStatus.PROCESSING },
        data: {
          status: EventStatus.PROCESSED,
          processedAt: now,
          lastError: null,
        },
      });
      processed += result.count;
      logger.info("webhook.processed", {
        eventId: event.id,
        webhookId: event.shopifyWebhookId,
        topic: event.topic,
      });
    } catch (error) {
      const attempts = event.attempts + 1;
      const isDead = attempts >= MAX_WEBHOOK_ATTEMPTS;
      const nextAttemptAt = isDead
        ? now
        : new Date(now.getTime() + retryBackoffSeconds(event.attempts) * 1_000);
      const result = await client.webhookEvent.updateMany({
        where: { id: event.id, status: EventStatus.PROCESSING },
        data: {
          attempts,
          status: isDead ? EventStatus.DEAD : EventStatus.FAILED,
          nextAttemptAt,
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      failed += result.count;
      if (isDead) dead += result.count;
      logger.error("webhook.failed", {
        eventId: event.id,
        webhookId: event.shopifyWebhookId,
        topic: event.topic,
        attempts,
        dead: isDead,
        error,
      });
    }
  }

  return {
    claimed: events.length,
    processed,
    failed,
    dead,
    reclaimed: reclaimed.reclaimed,
  };
}

export async function requeueDeadEvents(
  client: PrismaClient = prisma,
): Promise<number> {
  const result = await client.webhookEvent.updateMany({
    where: { status: EventStatus.DEAD },
    data: {
      status: EventStatus.PENDING,
      attempts: 0,
      nextAttemptAt: new Date(),
      lastError: null,
      processedAt: null,
    },
  });
  return result.count;
}
