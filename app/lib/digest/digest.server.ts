import { randomUUID } from "node:crypto";
import {
  AlertKind,
  Channel,
  DeliveryStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import prisma from "../../db.server";
import { featuresForShop } from "../billing/plans.server";
import type { Clock } from "../ports";

export type LocalTime = { date: string; hour: number };

export function localTimeAt(instant: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour")),
  };
}

export type DigestContent = {
  kind: "digest";
  subject: string;
  text: string;
  html: string;
  counts: {
    ordersAlerted: number;
    deliveries: Record<string, number>;
    bounces: number;
  };
};

export function buildDigestContent(input: {
  shopDomain: string;
  localDate: string;
  ordersAlerted: number;
  deliveryStatuses: DeliveryStatus[];
}): DigestContent {
  const deliveries: Record<string, number> = {};
  for (const status of input.deliveryStatuses) {
    const key = status.toLowerCase();
    deliveries[key] = (deliveries[key] ?? 0) + 1;
  }
  const bounces = deliveries.bounced ?? 0;
  const statusLine = Object.entries(deliveries)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}: ${count}`)
    .join(", ");
  const warning = bounces > 0 ? ` Attention: ${bounces} bounced.` : "";
  const subject = `AlertProof daily digest — ${input.localDate}`;
  const text = [
    subject,
    `Shop: ${input.shopDomain}`,
    `Orders alerted: ${input.ordersAlerted}`,
    `Deliveries: ${statusLine || "none"}.${warning}`,
  ].join("\n");
  const html = `<h1>${subject}</h1><p>Shop: ${input.shopDomain}</p><p>Orders alerted: ${input.ordersAlerted}</p><p>Deliveries: ${statusLine || "none"}.</p>${bounces > 0 ? `<p><strong>Attention: ${bounces} bounced.</strong></p>` : ""}`;
  return {
    kind: "digest",
    subject,
    text,
    html,
    counts: { ordersAlerted: input.ordersAlerted, deliveries, bounces },
  };
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function runDailyDigests(
  input: {
    client?: PrismaClient;
    clock?: Clock;
    now?: Date;
  } = {},
): Promise<{
  eligible: number;
  created: number;
  gated: number;
  duplicates: number;
}> {
  const client = input.client ?? prisma;
  const now = input.now ?? input.clock?.now() ?? new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60_000);
  const recentDigestCutoff = new Date(now.getTime() - 20 * 60 * 60_000);
  const recipients = await client.recipient.findMany({
    where: { digestEnabled: true, shop: { uninstalledAt: null } },
    include: { shop: true },
    orderBy: { id: "asc" },
  });
  let eligible = 0;
  let created = 0;
  let gated = 0;
  let duplicates = 0;

  for (const recipient of recipients) {
    const local = localTimeAt(now, recipient.shop.timezone);
    if (local.hour !== recipient.digestHourLocal) continue;
    eligible += 1;
    const dedupeKey = `digest:${recipient.id}:${local.date}`;
    const recent = await client.alert.findFirst({
      where: {
        shopId: recipient.shopId,
        kind: AlertKind.DIGEST,
        dedupeKey: { startsWith: `digest:${recipient.id}:` },
        firedAt: { gte: recentDigestCutoff },
      },
      select: { id: true },
    });
    if (recent) {
      duplicates += 1;
      continue;
    }
    const [orders, deliveryRows] = await Promise.all([
      client.alert.findMany({
        where: {
          shopId: recipient.shopId,
          kind: AlertKind.RULE,
          firedAt: { gte: since, lt: now },
          deliveries: { some: { recipientId: recipient.id } },
          orderId: { not: null },
        },
        distinct: ["orderId"],
        select: { orderId: true },
      }),
      client.delivery.findMany({
        where: {
          recipientId: recipient.id,
          createdAt: { gte: since, lt: now },
          alert: { kind: AlertKind.RULE },
        },
        select: { status: true },
      }),
    ]);
    const content = buildDigestContent({
      shopDomain: recipient.shop.shopDomain,
      localDate: local.date,
      ordersAlerted: orders.length,
      deliveryStatuses: deliveryRows.map((row) => row.status),
    });
    const allowed = featuresForShop(recipient.shop, now).digest;
    const status =
      allowed && recipient.email
        ? DeliveryStatus.PENDING
        : DeliveryStatus.SKIPPED;
    const reason = !allowed
      ? "plan"
      : recipient.email
        ? null
        : "Recipient has no email destination configured";
    const alertId = randomUUID();
    const inserted = await client.$transaction(async (tx) => {
      const alert = await tx.alert.createMany({
        data: [
          {
            id: alertId,
            shopId: recipient.shopId,
            kind: AlertKind.DIGEST,
            dedupeKey,
            firedAt: now,
            writebackPending: false,
          },
        ],
        skipDuplicates: true,
      });
      if (alert.count === 0) return false;
      await tx.delivery.create({
        data: {
          alertId,
          recipientId: recipient.id,
          channel: Channel.EMAIL,
          messageKey: dedupeKey,
          destination: recipient.email ?? `unconfigured:${recipient.id}`,
          status,
          statusAt: status === DeliveryStatus.SKIPPED ? now : null,
          lastError: reason,
          providerDetail: json(content),
          nextAttemptAt: now,
        },
      });
      return true;
    });
    if (!inserted) {
      duplicates += 1;
      continue;
    }
    created += 1;
    if (!allowed) gated += 1;
  }
  return { eligible, created, gated, duplicates };
}
