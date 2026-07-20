import { EventSource, type Prisma, type PrismaClient } from "@prisma/client";
import prisma from "../../db.server";
import { canonicalizeTopic, extractOrderId } from "./topics";

export type EnqueueWebhookInput = {
  shopDomain: string;
  topic: string;
  shopifyWebhookId: string;
  payload: Record<string, unknown>;
  source?: EventSource;
  receivedAt?: Date;
};

export type EnqueueWebhookResult = {
  inserted: boolean;
  orderId: string | null;
  topic: string;
};

export async function enqueueWebhook(
  input: EnqueueWebhookInput,
  client: PrismaClient = prisma,
): Promise<EnqueueWebhookResult> {
  const topic = canonicalizeTopic(input.topic);
  const orderId = extractOrderId(topic, input.payload);
  const receivedAt = input.receivedAt ?? new Date();
  const trialEndsAt = new Date(receivedAt);
  trialEndsAt.setUTCDate(trialEndsAt.getUTCDate() + 14);

  const inserted = await client.$transaction(async (tx) => {
    await tx.shop.upsert({
      where: { shopDomain: input.shopDomain },
      update: {},
      create: {
        shopDomain: input.shopDomain,
        installedAt: receivedAt,
        trialEndsAt,
        reconcileCursor: receivedAt,
        timezone: "UTC",
      },
    });

    const result = await tx.webhookEvent.createMany({
      data: [
        {
          shopDomain: input.shopDomain,
          topic,
          shopifyWebhookId: input.shopifyWebhookId,
          source: input.source ?? EventSource.WEBHOOK,
          orderId,
          payload: input.payload as Prisma.InputJsonObject,
          receivedAt,
          nextAttemptAt: receivedAt,
        },
      ],
      skipDuplicates: true,
    });
    return result.count === 1;
  });

  return { inserted, orderId, topic };
}
