import { Prisma, type PrismaClient } from "@prisma/client";
import prisma from "../../db.server";
import type {
  AlertChannelAdapter,
  DeliveryLogStore,
  StatusWebhook,
} from "../ports";
import { PrismaDeliveryLogStore } from "./log.server";
import { logger } from "../logger.server";

export class ProviderWebhookAuthenticationError extends Error {}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function handleProviderStatusWebhook(input: {
  adapter: AlertChannelAdapter;
  webhook: StatusWebhook;
  client?: PrismaClient;
  store?: DeliveryLogStore;
}): Promise<{ accepted: boolean; matched: boolean }> {
  if (!input.adapter.verifyStatusWebhook || !input.adapter.parseStatusEvent) {
    throw new Error(`${input.adapter.kind} does not support status callbacks`);
  }
  if (!(await input.adapter.verifyStatusWebhook(input.webhook))) {
    throw new ProviderWebhookAuthenticationError(
      "Invalid provider webhook authentication",
    );
  }
  const event = await input.adapter.parseStatusEvent(input.webhook);
  const client = input.client ?? prisma;
  const providerEvent = await client.providerEvent.create({
    data: {
      provider: event.provider,
      providerMessageId: event.providerMessageId,
      type: event.type,
      payload: json(event.detail),
      receivedAt: event.occurredAt,
    },
  });
  const matched = event.status
    ? await (input.store ?? new PrismaDeliveryLogStore(client)).updateStatus({
        ...event,
        status: event.status,
      })
    : false;
  await client.providerEvent.update({
    where: { id: providerEvent.id },
    data: { processedAt: new Date() },
  });
  if (!matched && event.status) {
    logger.warn("provider_status.unmatched", {
      provider: event.provider,
      providerMessageId: event.providerMessageId,
    });
  }
  return { accepted: true, matched };
}
