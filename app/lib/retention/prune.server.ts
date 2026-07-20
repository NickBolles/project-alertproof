import { Prisma, type PrismaClient } from "@prisma/client";
import prisma from "../../db.server";

/**
 * Prunes heavyweight audit detail only. Alert rows are durable idempotency
 * skeletons and must never be deleted, regardless of plan retention window.
 */
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
    const deliveries = await tx.delivery.deleteMany({
      where: { createdAt: { lt: input.cutoff } },
    });
    const providerEvents = await tx.providerEvent.deleteMany({
      where: { receivedAt: { lt: input.cutoff } },
    });
    const nulled = await tx.webhookEvent.updateMany({
      where: { receivedAt: { lt: input.cutoff } },
      data: { payload: Prisma.DbNull },
    });
    return {
      deliveries: deliveries.count,
      providerEvents: providerEvents.count,
      webhookPayloads: nulled.count,
    };
  });
}
