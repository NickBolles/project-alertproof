import { DeliveryStatus, Prisma, type PrismaClient } from "@prisma/client";
import prisma from "../../db.server";
import { createAdapters } from "../adapters/index.server";
import type { Clock, ShopifyAdmin } from "../ports";

const TERMINAL = new Set<DeliveryStatus>([
  DeliveryStatus.DELIVERED,
  DeliveryStatus.BOUNCED,
  DeliveryStatus.FAILED,
  DeliveryStatus.SKIPPED,
]);
const MAX_WRITEBACK_ATTEMPTS = 3;

type AlertForWriteback = Prisma.AlertGetPayload<{
  include: { deliveries: true };
}>;

export function buildOrderWriteback(
  alerts: AlertForWriteback[],
  now: Date,
): { metafieldValue: string; note: string } {
  const deliveries = alerts.flatMap((alert) => alert.deliveries);
  const delivered = deliveries.filter(
    (delivery) => delivery.status === DeliveryStatus.DELIVERED,
  ).length;
  const bounced = deliveries.filter(
    (delivery) => delivery.status === DeliveryStatus.BOUNCED,
  ).length;
  const channelCounts = new Map<string, number>();
  for (const delivery of deliveries) {
    const channel = delivery.channel.toLowerCase();
    channelCounts.set(channel, (channelCounts.get(channel) ?? 0) + 1);
  }
  const channels = [...channelCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([channel, count]) => `${channel} x${count}`)
    .join(", ");
  return {
    metafieldValue: JSON.stringify({
      alerts: alerts.length,
      delivered,
      bounced,
      lastUpdate: now.toISOString(),
    }),
    note: `AlertProof: ${delivered}/${deliveries.length} deliveries delivered${channels ? ` (${channels})` : ""}`,
  };
}

function settings(value: Prisma.JsonValue): {
  enabled: boolean;
  metafield: boolean;
  note: boolean;
} {
  const object =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    enabled: object.writeback !== false,
    metafield: object.writebackMetafield !== false,
    note: object.writebackNote !== false,
  };
}

export async function processPendingWritebacks(
  input: {
    shopifyAdmin?: ShopifyAdmin;
    client?: PrismaClient;
    clock?: Clock;
    limit?: number;
  } = {},
): Promise<{ processed: number; failed: number; deferred: number }> {
  const client = input.client ?? prisma;
  const now = input.clock?.now() ?? new Date();
  const shopifyAdmin = input.shopifyAdmin ?? createAdapters().shopifyAdmin;
  const candidates = await client.alert.findMany({
    where: {
      writebackPending: true,
      writebackNextAt: { lte: now },
      orderId: { not: null },
    },
    orderBy: { writebackNextAt: "asc" },
    take: input.limit ?? 25,
    select: { shopId: true, orderId: true },
    distinct: ["shopId", "orderId"],
  });
  let processed = 0;
  let failed = 0;
  let deferred = 0;

  for (const candidate of candidates) {
    const orderId = candidate.orderId!;
    const shop = await client.shop.findUniqueOrThrow({
      where: { id: candidate.shopId },
    });
    const alerts = await client.alert.findMany({
      where: { shopId: shop.id, orderId },
      include: { deliveries: true },
    });
    if (
      alerts.some((alert) =>
        alert.deliveries.some((delivery) => !TERMINAL.has(delivery.status)),
      )
    ) {
      await client.alert.updateMany({
        where: { shopId: shop.id, orderId },
        data: { writebackNextAt: new Date(now.getTime() + 60_000) },
      });
      deferred += 1;
      continue;
    }
    const config = settings(shop.settings);
    if (!config.enabled) {
      await client.alert.updateMany({
        where: { shopId: shop.id, orderId },
        data: {
          writebackPending: false,
          writebackAt: now,
          writebackError: null,
        },
      });
      processed += 1;
      continue;
    }
    try {
      const summary = buildOrderWriteback(alerts, now);
      if (config.metafield) {
        await shopifyAdmin.writeOrderMetafield({
          shopDomain: shop.shopDomain,
          orderId,
          namespace: "alertproof",
          key: "status",
          value: summary.metafieldValue,
        });
      }
      if (config.note) {
        await shopifyAdmin.addOrderNote({
          shopDomain: shop.shopDomain,
          orderId,
          note: summary.note,
        });
      }
      await client.alert.updateMany({
        where: { shopId: shop.id, orderId },
        data: {
          writebackPending: false,
          writebackAttempts: 0,
          writebackAt: now,
          writebackError: null,
        },
      });
      processed += 1;
    } catch (error) {
      const attempts =
        Math.max(...alerts.map((alert) => alert.writebackAttempts)) + 1;
      await client.alert.updateMany({
        where: { shopId: shop.id, orderId },
        data: {
          writebackPending: attempts < MAX_WRITEBACK_ATTEMPTS,
          writebackAttempts: attempts,
          writebackNextAt: new Date(
            now.getTime() + 30_000 * 2 ** (attempts - 1),
          ),
          writebackError:
            error instanceof Error ? error.message : String(error),
        },
      });
      failed += 1;
    }
  }
  return { processed, failed, deferred };
}
