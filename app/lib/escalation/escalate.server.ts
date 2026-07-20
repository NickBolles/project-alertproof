import {
  Channel,
  DeliveryStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import prisma from "../../db.server";
import { featuresForShop } from "../billing/plans.server";
import type { Clock } from "../ports";

export type EscalationConfig = {
  afterMinutes: number;
  channel: Channel;
};

export function parseEscalationConfig(value: unknown): EscalationConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { afterMinutes?: unknown; channel?: unknown };
  const afterMinutes = Number(candidate.afterMinutes);
  if (
    !Number.isInteger(afterMinutes) ||
    afterMinutes < 1 ||
    afterMinutes > 10_080 ||
    !Object.values(Channel).includes(candidate.channel as Channel)
  ) {
    return null;
  }
  return { afterMinutes, channel: candidate.channel as Channel };
}

function destinationFor(
  recipient: {
    email: string | null;
    slackWebhookUrlEnc: string | null;
    discordWebhookUrlEnc: string | null;
    phoneE164: string | null;
  },
  channel: Channel,
): string | null {
  if (channel === Channel.EMAIL) return recipient.email;
  if (channel === Channel.SLACK) return recipient.slackWebhookUrlEnc;
  if (channel === Channel.DISCORD) return recipient.discordWebhookUrlEnc;
  return recipient.phoneE164;
}

function uniqueConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/**
 * MVP escalation means "not delivered", not "not opened". The database unique
 * on escalatedFromId is the concurrency guard; this function deliberately does
 * not perform a check-then-insert.
 */
export async function escalateDueDeliveries(
  input: {
    client?: PrismaClient;
    clock?: Clock;
    now?: Date;
    limit?: number;
  } = {},
): Promise<{
  scanned: number;
  created: number;
  skipped: number;
  duplicates: number;
}> {
  const client = input.client ?? prisma;
  const now = input.now ?? input.clock?.now() ?? new Date();
  const candidates = await client.delivery.findMany({
    where: {
      isEscalation: false,
      // Avoid retrying known work; escalatedFromId's unique constraint remains
      // the authoritative guard for overlapping scans racing after this read.
      escalation: null,
      status: {
        in: [
          DeliveryStatus.BOUNCED,
          DeliveryStatus.SENT,
          DeliveryStatus.DEFERRED,
        ],
      },
      alert: {
        kind: "RULE",
        rule: { is: { escalation: { not: Prisma.DbNull } } },
      },
    },
    include: {
      recipient: true,
      alert: { include: { rule: true, shop: true } },
    },
    orderBy: [{ statusAt: "asc" }, { id: "asc" }],
    take: Math.max(1, input.limit ?? 100),
  });
  let created = 0;
  let skipped = 0;
  let duplicates = 0;

  for (const source of candidates) {
    const config = parseEscalationConfig(source.alert.rule?.escalation);
    if (!config || source.channel === config.channel) continue;
    const due =
      source.status === DeliveryStatus.BOUNCED ||
      (Boolean(source.sentAt) &&
        source.sentAt!.getTime() <=
          now.getTime() - config.afterMinutes * 60_000);
    if (!due) continue;

    const feature = featuresForShop(source.alert.shop, now);
    const destination = destinationFor(source.recipient, config.channel);
    const allowed =
      feature.escalation && feature.channels.includes(config.channel as never);
    const status =
      allowed && destination ? DeliveryStatus.PENDING : DeliveryStatus.SKIPPED;
    const reason = !feature.escalation
      ? "plan"
      : !destination
        ? `Recipient has no ${config.channel.toLowerCase()} destination configured`
        : !allowed
          ? "plan"
          : null;
    try {
      await client.delivery.create({
        data: {
          alertId: source.alertId,
          recipientId: source.recipientId,
          channel: config.channel,
          messageKey: `${source.messageKey}:escalation:${source.id}`,
          destination: destination ?? `unconfigured:${source.recipientId}`,
          status,
          statusAt: status === DeliveryStatus.SKIPPED ? now : null,
          lastError: reason,
          nextAttemptAt: now,
          isEscalation: true,
          escalatedFromId: source.id,
        },
      });
      created += 1;
      if (status === DeliveryStatus.SKIPPED) skipped += 1;
    } catch (error) {
      if (uniqueConflict(error)) {
        duplicates += 1;
        continue;
      }
      throw error;
    }
  }
  return { scanned: candidates.length, created, skipped, duplicates };
}
