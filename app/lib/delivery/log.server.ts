import {
  Channel,
  DeliveryStatus as PrismaDeliveryStatus,
  Prisma,
  type Delivery,
  type PrismaClient,
} from "@prisma/client";
import prisma from "../../db.server";
import type {
  ChannelType,
  DeliveryLogEntry,
  DeliveryLogStore,
  DeliveryRoute,
  DeliveryStatus,
  ProviderStatusEvent,
} from "../ports";
import { CHANNEL_TYPE_TO_PRISMA, DELIVERY_STATUS_TO_PRISMA } from "../ports";

export const MAX_DELIVERY_ATTEMPTS = 3;
export const DELIVERY_LEASE_MS = 10 * 60_000;

// Delivery is deliberately at-least-once: reclaiming an expired SENDING lease
// can resend after a crash that occurred after provider I/O but before SENT was
// persisted. The durable Alert/route keys prevent duplicate records, not an
// unknowable duplicate provider side effect; avoiding drops is the priority.

const statusFromPrisma: Record<PrismaDeliveryStatus, DeliveryStatus> = {
  PENDING: "queued",
  SENDING: "sending",
  SENT: "sent",
  DELIVERED: "delivered",
  BOUNCED: "bounced",
  DEFERRED: "deferred",
  FAILED: "failed",
  SKIPPED: "skipped",
};
const channelFromPrisma: Record<Channel, ChannelType> = {
  EMAIL: "email",
  SLACK: "slack",
  DISCORD: "discord",
  SMS: "sms",
};

function dbTimestamp(value: Date): Prisma.Sql {
  return Prisma.sql`${value.toISOString().replace(/Z$/, "")}::timestamp`;
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function entry(row: Delivery): DeliveryLogEntry {
  return {
    id: row.id,
    alertId: row.alertId,
    recipientId: row.recipientId,
    messageKey: row.messageKey,
    channelType: channelFromPrisma[row.channel],
    destination: row.destination,
    status: statusFromPrisma[row.status],
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    providerMessageId: row.providerMessageId,
  };
}

const CALLBACK_ALLOWED_FROM: Record<
  DeliveryStatus,
  ReadonlySet<DeliveryStatus>
> = {
  queued: new Set([
    "sending",
    "sent",
    "deferred",
    "delivered",
    "bounced",
    "failed",
  ]),
  sending: new Set(["sent", "deferred", "delivered", "bounced", "failed"]),
  sent: new Set(["deferred", "delivered", "bounced", "failed"]),
  deferred: new Set(["sent", "delivered", "bounced", "failed"]),
  delivered: new Set(["delivered"]),
  bounced: new Set(["bounced"]),
  failed: new Set(["failed"]),
  skipped: new Set(["skipped"]),
};

export const DELIVERY_STATUS_PRECEDENCE = {
  queued: 0,
  sending: 1,
  sent: 2,
  deferred: 3,
  delivered: 4,
  bounced: 4,
  failed: 4,
  skipped: 4,
} as const satisfies Record<DeliveryStatus, number>;

export class PrismaDeliveryLogStore implements DeliveryLogStore {
  constructor(private readonly client: PrismaClient = prisma) {}

  async record(route: DeliveryRoute): Promise<DeliveryLogEntry> {
    const channel = CHANNEL_TYPE_TO_PRISMA[route.channelType] as Channel;
    const status =
      route.enabled === false
        ? PrismaDeliveryStatus.SKIPPED
        : PrismaDeliveryStatus.PENDING;
    const row = await this.client.delivery.upsert({
      where: {
        messageKey_channel_destination: {
          messageKey: route.messageKey,
          channel,
          destination: route.destination,
        },
      },
      update: {},
      create: {
        alertId: route.alertId,
        recipientId: route.recipientId,
        messageKey: route.messageKey,
        channel,
        destination: route.destination,
        status,
        statusAt: status === PrismaDeliveryStatus.SKIPPED ? new Date() : null,
        lastError:
          status === PrismaDeliveryStatus.SKIPPED
            ? (route.skipReason ?? "Route disabled")
            : null,
      },
    });
    return entry(row);
  }

  async claimQueued(
    input: { now?: Date; limit?: number } = {},
  ): Promise<DeliveryLogEntry[]> {
    const now = input.now ?? new Date();
    const limit = Math.max(1, input.limit ?? 25);
    const nowSql = dbTimestamp(now);
    const rows = await this.client.$transaction((tx) =>
      tx.$queryRaw<Delivery[]>(Prisma.sql`
        WITH candidates AS (
          SELECT id
          FROM "Delivery"
          WHERE status = 'PENDING'::"DeliveryStatus"
            AND "nextAttemptAt" <= ${nowSql}
            AND attempts < ${MAX_DELIVERY_ATTEMPTS}
          ORDER BY "nextAttemptAt", "createdAt", id
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE "Delivery" AS delivery
        SET status = 'SENDING'::"DeliveryStatus",
            attempts = delivery.attempts + 1,
            "statusAt" = ${nowSql},
            "updatedAt" = ${nowSql}
        FROM candidates
        WHERE delivery.id = candidates.id
        RETURNING delivery.*
      `),
    );
    return rows.map(entry);
  }

  async transition(input: {
    deliveryId: string;
    from: DeliveryStatus;
    to: DeliveryStatus;
    at: Date;
    providerMessageId?: string;
    detail?: unknown;
    error?: string | null;
    nextAttemptAt?: Date;
  }): Promise<boolean> {
    return this.client.$transaction(async (tx) => {
      const result = await tx.delivery.updateMany({
        where: {
          id: input.deliveryId,
          status: DELIVERY_STATUS_TO_PRISMA[input.from] as PrismaDeliveryStatus,
        },
        data: {
          status: DELIVERY_STATUS_TO_PRISMA[input.to] as PrismaDeliveryStatus,
          statusAt: input.at,
          sentAt:
            input.to === "sent" || input.to === "delivered"
              ? input.at
              : undefined,
          providerMessageId: input.providerMessageId,
          providerDetail:
            input.detail === undefined ? undefined : json([input.detail]),
          lastError: input.error,
          nextAttemptAt: input.nextAttemptAt,
        },
      });
      if (result.count !== 1) return false;
      const delivery = await tx.delivery.findUniqueOrThrow({
        where: { id: input.deliveryId },
        select: {
          alertId: true,
          alert: { select: { webhookEvent: { select: { source: true } } } },
        },
      });
      if (delivery.alert.webhookEvent?.source !== "TEST") {
        await tx.alert.update({
          where: { id: delivery.alertId },
          data: {
            writebackPending: true,
            writebackAttempts: 0,
            writebackNextAt: new Date(input.at.getTime() + 60_000),
            writebackError: null,
          },
        });
      }
      return true;
    });
  }

  async updateStatus(event: ProviderStatusEvent): Promise<boolean> {
    return this.client.$transaction(async (tx) => {
      const current = await tx.delivery.findUnique({
        where: { providerMessageId: event.providerMessageId },
      });
      if (!current) return false;
      const from = statusFromPrisma[current.status];
      if (!CALLBACK_ALLOWED_FROM[from].has(event.status)) return true;
      const previous = Array.isArray(current.providerDetail)
        ? current.providerDetail
        : [];
      const result = await tx.delivery.updateMany({
        where: { id: current.id, status: current.status },
        data: {
          status: DELIVERY_STATUS_TO_PRISMA[
            event.status
          ] as PrismaDeliveryStatus,
          statusAt: event.occurredAt,
          sentAt:
            event.status === "delivered"
              ? (current.sentAt ?? event.occurredAt)
              : undefined,
          providerDetail: json([...previous, event.detail]),
        },
      });
      if (result.count === 1) {
        const alert = await tx.alert.findUniqueOrThrow({
          where: { id: current.alertId },
          select: { webhookEvent: { select: { source: true } } },
        });
        if (alert.webhookEvent?.source !== "TEST") {
          await tx.alert.update({
            where: { id: current.alertId },
            data: {
              writebackPending: true,
              writebackAttempts: 0,
              writebackNextAt: new Date(event.occurredAt.getTime() + 60_000),
              writebackError: null,
            },
          });
        }
        return true;
      }
      return Boolean(
        await tx.delivery.findUnique({
          where: { providerMessageId: event.providerMessageId },
          select: { id: true },
        }),
      );
    });
  }
}

export async function reclaimStuckDeliveries(
  input: {
    client?: PrismaClient;
    now?: Date;
  } = {},
): Promise<{ requeued: number; failed: number }> {
  const client = input.client ?? prisma;
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - DELIVERY_LEASE_MS);
  const rows = await client.$queryRaw<
    Array<{ status: PrismaDeliveryStatus }>
  >(Prisma.sql`
    UPDATE "Delivery"
    SET attempts = attempts + 1,
        status = CASE
          WHEN attempts + 1 >= ${MAX_DELIVERY_ATTEMPTS} THEN 'FAILED'::"DeliveryStatus"
          ELSE 'PENDING'::"DeliveryStatus"
        END,
        "nextAttemptAt" = ${dbTimestamp(now)},
        "statusAt" = ${dbTimestamp(now)},
        "lastError" = 'Delivery lease expired before provider result was recorded',
        "updatedAt" = ${dbTimestamp(now)}
    WHERE status = 'SENDING'::"DeliveryStatus"
      AND "statusAt" < ${dbTimestamp(cutoff)}
    RETURNING status
  `);
  return {
    requeued: rows.filter((row) => row.status === PrismaDeliveryStatus.PENDING)
      .length,
    failed: rows.filter((row) => row.status === PrismaDeliveryStatus.FAILED)
      .length,
  };
}
