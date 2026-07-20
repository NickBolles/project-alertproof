import { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import type { MockOutboxRecord, OutboxWriter, ShopPlanStore } from "../ports";
import type { BillingPlan } from "../ports";

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export class PrismaOutboxWriter implements OutboxWriter {
  async write(record: MockOutboxRecord): Promise<void> {
    await prisma.mockOutbox.create({
      data: {
        channel: record.channel,
        to: record.to,
        payload: toJson(record.payload),
        deliveryId: record.deliveryId,
      },
    });
  }
}

export class PrismaShopPlanStore implements ShopPlanStore {
  async get(shopId: string): Promise<BillingPlan | null> {
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { plan: true },
    });
    return shop?.plan ?? null;
  }

  async set(
    shopId: string,
    plan: BillingPlan,
    billingChargeId?: string,
  ): Promise<void> {
    await prisma.shop.update({
      where: { id: shopId },
      data: { plan, billingChargeId },
    });
  }
}
