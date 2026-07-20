import type { PrismaClient } from "@prisma/client";
import prisma from "../../db.server";
import { createAdapters, type Adapters } from "../adapters/index.server";
import { decryptSecret } from "../crypto.server";
import { env } from "../env.server";
import type {
  AlertDispatcher as AlertDispatcherContract,
  Clock,
  DeliveryLogStore,
  DeliveryRoute,
} from "../ports";
import {
  MAX_DELIVERY_ATTEMPTS,
  PrismaDeliveryLogStore,
  reclaimStuckDeliveries,
} from "./log.server";
import { renderAlertMessage, renderDigestMessage } from "./templates.server";
import { logger } from "../logger.server";

function plainDestination(value: string): string {
  return value.startsWith("v1:")
    ? decryptSecret(value, env.ALERTPROOF_ENCRYPTION_KEY)
    : value;
}

export class AlertDispatcher implements AlertDispatcherContract {
  constructor(
    private readonly store: DeliveryLogStore = new PrismaDeliveryLogStore(),
    private readonly client: PrismaClient = prisma,
    private readonly adapters: Adapters = createAdapters(),
    private readonly clock: Clock = createAdapters().clock,
  ) {}

  async dispatch(routes: DeliveryRoute[] = []) {
    for (const route of routes) await this.store.record(route);
    const now = this.clock.now();
    await reclaimStuckDeliveries({ client: this.client, now });
    const claimed = await this.store.claimQueued({ now });
    let sent = 0;
    let failed = 0;

    for (const delivery of claimed) {
      logger.info("delivery.claimed", {
        deliveryId: delivery.id,
        alertId: delivery.alertId,
        channel: delivery.channelType,
        attempt: delivery.attempts,
      });
      try {
        const destination = plainDestination(delivery.destination);
        const details = await this.client.delivery.findUniqueOrThrow({
          where: { id: delivery.id },
          include: {
            alert: { include: { shop: true, rule: true } },
          },
        });
        const message =
          renderDigestMessage({
            deliveryId: delivery.id,
            messageKey: delivery.messageKey,
            destination,
            detail: details.providerDetail,
          }) ??
          renderAlertMessage({
            deliveryId: delivery.id,
            messageKey: delivery.messageKey,
            channelType: delivery.channelType,
            destination,
            shopDomain: details.alert.shop.shopDomain,
            ruleName: details.alert.rule?.name,
            orderId: details.alert.orderId,
            orderName: details.alert.orderName,
            orderValue: details.alert.orderValue?.toString(),
          });
        const adapter =
          delivery.channelType === "sms"
            ? this.adapters.smsForShop(details.alert.shop.settings, destination)
            : this.adapters.channelFor(delivery.channelType, destination);
        const result = await adapter.send(message);
        const terminal =
          adapter.kind === "mock" ||
          delivery.channelType === "slack" ||
          delivery.channelType === "discord";
        const changed = await this.store.transition({
          deliveryId: delivery.id,
          from: "sending",
          to: terminal ? "delivered" : "sent",
          at: result.acceptedAt,
          providerMessageId: result.providerMessageId,
          detail: { provider: adapter.kind, acceptedAt: result.acceptedAt },
          error: null,
        });
        if (changed) {
          sent += 1;
          logger.info("delivery.sent", {
            deliveryId: delivery.id,
            provider: adapter.kind,
            providerMessageId: result.providerMessageId,
          });
        }
      } catch (error) {
        const exhausted = delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
        const delaySeconds = 30 * 2 ** Math.max(0, delivery.attempts - 1);
        const changed = await this.store.transition({
          deliveryId: delivery.id,
          from: "sending",
          to: exhausted ? "failed" : "queued",
          at: now,
          nextAttemptAt: exhausted
            ? undefined
            : new Date(now.getTime() + delaySeconds * 1_000),
          error: error instanceof Error ? error.message : String(error),
        });
        if (changed && exhausted) failed += 1;
        logger.error("delivery.failed", {
          deliveryId: delivery.id,
          exhausted,
          error,
        });
      }
    }

    return { recorded: routes.length, claimed: claimed.length, sent, failed };
  }
}

export async function dispatchPendingDeliveries(
  input: {
    client?: PrismaClient;
    store?: DeliveryLogStore;
    adapters?: Adapters;
    clock?: Clock;
  } = {},
) {
  const adapters = input.adapters ?? createAdapters();
  return new AlertDispatcher(
    input.store ?? new PrismaDeliveryLogStore(input.client ?? prisma),
    input.client ?? prisma,
    adapters,
    input.clock ?? adapters.clock,
  ).dispatch();
}
