import { EventStatus, Prisma, type PrismaClient } from "@prisma/client";
import prisma from "../db.server";

export type HealthSnapshot = {
  ok: boolean;
  database: { ok: boolean };
  queue: {
    depth: number;
    dead: number;
    oldestPendingAgeSeconds: number | null;
  };
};

export async function getHealthSnapshot(
  client: PrismaClient = prisma,
  now = new Date(),
): Promise<HealthSnapshot> {
  await client.$queryRaw(Prisma.sql`SELECT 1`);
  const [depth, dead, oldest] = await Promise.all([
    client.webhookEvent.count({
      where: { status: { in: [EventStatus.PENDING, EventStatus.FAILED] } },
    }),
    client.webhookEvent.count({ where: { status: EventStatus.DEAD } }),
    client.webhookEvent.findFirst({
      where: { status: { in: [EventStatus.PENDING, EventStatus.FAILED] } },
      orderBy: { receivedAt: "asc" },
      select: { receivedAt: true },
    }),
  ]);
  return {
    ok: dead === 0,
    database: { ok: true },
    queue: {
      depth,
      dead,
      oldestPendingAgeSeconds: oldest
        ? Math.max(
            0,
            Math.floor((now.getTime() - oldest.receivedAt.getTime()) / 1_000),
          )
        : null,
    },
  };
}
