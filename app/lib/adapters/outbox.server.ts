import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import type { MockOutboxRecord, OutboxWriter, ShopPlanStore } from "../ports";
import type { BillingPlan } from "../ports";

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export class PrismaOutboxWriter implements OutboxWriter {
  constructor(
    private readonly outboxRoot = path.join(process.cwd(), "var", "outbox"),
  ) {}

  async write(record: MockOutboxRecord): Promise<void> {
    await Promise.all([
      prisma.mockOutbox.create({
        data: {
          channel: record.channel,
          to: record.to,
          payload: toJson(record.payload),
          deliveryId: record.deliveryId,
        },
      }),
      this.appendJsonLine(record),
    ]);
  }

  private async appendJsonLine(record: MockOutboxRecord): Promise<void> {
    await mkdir(this.outboxRoot, { recursive: true });
    await appendFile(
      path.join(this.outboxRoot, `${record.channel}.jsonl`),
      `${JSON.stringify({ ...record, recordedAt: new Date().toISOString() })}\n`,
      "utf8",
    );
  }
}

export class PrismaShopPlanStore implements ShopPlanStore {
  constructor(private readonly client = prisma) {}

  async get(shopId: string): Promise<BillingPlan | null> {
    const shop = await this.client.shop.findUnique({
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
    await this.client.shop.update({
      where: { id: shopId },
      data: { plan, billingChargeId: billingChargeId ?? null },
    });
  }
}
