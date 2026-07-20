import { EventStatus, Prisma, type PrismaClient } from "@prisma/client";
import prisma from "../../db.server";
import { featuresForShop } from "../billing/plans.server";
import type { Clock } from "../ports";

const DAY_MS = 24 * 60 * 60_000;
export const RETENTION_BATCH_SIZE = 1_000;

/** Compatibility helper for an explicit global cutoff. Alert rows are untouched. */
export async function pruneExpiredDetail(input: {
  cutoff: Date;
  client?: PrismaClient;
}): Promise<{
  deliveries: number;
  providerEvents: number;
  webhookPayloads: number;
}> {
  const client = input.client ?? prisma;
  return client.$transaction(async (tx) => {
    const expired = await tx.delivery.findMany({
      where: { createdAt: { lt: input.cutoff } },
      select: { id: true, providerMessageId: true },
      take: RETENTION_BATCH_SIZE,
    });
    const providerMessageIds = expired
      .map((row) => row.providerMessageId)
      .filter((id): id is string => Boolean(id));
    const providerEvents = providerMessageIds.length
      ? await tx.providerEvent.deleteMany({
          where: {
            providerMessageId: { in: providerMessageIds },
            receivedAt: { lt: input.cutoff },
          },
        })
      : { count: 0 };
    const deliveries = expired.length
      ? await tx.delivery.deleteMany({
          where: { id: { in: expired.map((row) => row.id) } },
        })
      : { count: 0 };
    const payloadRows = await tx.webhookEvent.findMany({
      where: {
        receivedAt: { lt: input.cutoff },
        payload: { not: Prisma.DbNull },
      },
      select: { id: true },
      take: RETENTION_BATCH_SIZE,
    });
    const nulled = payloadRows.length
      ? await tx.webhookEvent.updateMany({
          where: { id: { in: payloadRows.map((row) => row.id) } },
          data: { payload: Prisma.DbNull },
        })
      : { count: 0 };
    return {
      deliveries: deliveries.count,
      providerEvents: providerEvents.count,
      webhookPayloads: nulled.count,
    };
  });
}

export async function runRetentionPrune(
  input: {
    client?: PrismaClient;
    clock?: Clock;
    now?: Date;
    batchSize?: number;
  } = {},
): Promise<{
  deliveries: number;
  providerEvents: number;
  alertSkeletons: number;
  webhookPayloads: number;
  deadEvents: number;
}> {
  const client = input.client ?? prisma;
  const now = input.now ?? input.clock?.now() ?? new Date();
  const batchSize = Math.min(
    RETENTION_BATCH_SIZE,
    Math.max(1, input.batchSize ?? RETENTION_BATCH_SIZE),
  );
  const totals = {
    deliveries: 0,
    providerEvents: 0,
    alertSkeletons: 0,
    webhookPayloads: 0,
    deadEvents: 0,
  };
  const shops = await client.shop.findMany({
    select: { id: true, plan: true, trialEndsAt: true },
    orderBy: { id: "asc" },
  });

  for (const shop of shops) {
    const retentionDays = featuresForShop(shop, now).retentionDays;
    if (retentionDays === null) continue;
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
    let deliveryBatchCount: number;
    do {
      const rows = await client.delivery.findMany({
        where: { alert: { shopId: shop.id }, createdAt: { lt: cutoff } },
        select: { id: true, providerMessageId: true },
        take: batchSize,
        orderBy: { id: "asc" },
      });
      deliveryBatchCount = rows.length;
      if (!rows.length) continue;
      const providerMessageIds = rows
        .map((row) => row.providerMessageId)
        .filter((id): id is string => Boolean(id));
      const result = await client.$transaction(async (tx) => {
        const providerEvents = providerMessageIds.length
          ? await tx.providerEvent.deleteMany({
              where: {
                providerMessageId: { in: providerMessageIds },
                receivedAt: { lt: cutoff },
              },
            })
          : { count: 0 };
        const deliveries = await tx.delivery.deleteMany({
          where: { id: { in: rows.map((row) => row.id) } },
        });
        return {
          deliveries: deliveries.count,
          providerEvents: providerEvents.count,
        };
      });
      totals.deliveries += result.deliveries;
      totals.providerEvents += result.providerEvents;
    } while (deliveryBatchCount === batchSize);
    let alertBatchCount: number;
    do {
      const rows = await client.alert.findMany({
        where: {
          shopId: shop.id,
          firedAt: { lt: cutoff },
          OR: [{ orderName: { not: null } }, { orderValue: { not: null } }],
        },
        select: { id: true },
        take: batchSize,
        orderBy: { id: "asc" },
      });
      alertBatchCount = rows.length;
      if (!rows.length) continue;
      const result = await client.alert.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { orderName: null, orderValue: null },
      });
      totals.alertSkeletons += result.count;
    } while (alertBatchCount === batchSize);
  }

  const payloadCutoff = new Date(now.getTime() - 30 * DAY_MS);
  let payloadBatchCount: number;
  do {
    const rows = await client.webhookEvent.findMany({
      where: {
        receivedAt: { lt: payloadCutoff },
        payload: { not: Prisma.DbNull },
      },
      select: { id: true },
      take: batchSize,
      orderBy: { id: "asc" },
    });
    payloadBatchCount = rows.length;
    if (!rows.length) continue;
    const result = await client.webhookEvent.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: { payload: Prisma.DbNull },
    });
    totals.webhookPayloads += result.count;
  } while (payloadBatchCount === batchSize);

  const deadCutoff = new Date(now.getTime() - 90 * DAY_MS);
  let deadBatchCount: number;
  do {
    const rows = await client.webhookEvent.findMany({
      where: { status: EventStatus.DEAD, receivedAt: { lt: deadCutoff } },
      select: { id: true },
      take: batchSize,
      orderBy: { id: "asc" },
    });
    deadBatchCount = rows.length;
    if (!rows.length) continue;
    const result = await client.webhookEvent.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    totals.deadEvents += result.count;
  } while (deadBatchCount === batchSize);
  return totals;
}
