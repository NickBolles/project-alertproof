import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../app/lib/adapters/clock/fake.server";
import { MockShopifyAdmin } from "../../app/lib/adapters/shopify-admin/mock.server";
import { provisionShop } from "../../app/lib/ingest/provision.server";

describe("shop provisioning", () => {
  it("initializes install, trial, reconciliation cursor, and timezone", async () => {
    const upsert = vi.fn(async (args) => args.create);
    const client = { shop: { upsert } } as unknown as PrismaClient;
    const installedAt = new Date("2026-07-20T12:00:00.000Z");

    const shop = await provisionShop({
      shopDomain: "fixture.myshopify.com",
      shopifyAdmin: new MockShopifyAdmin({ timezone: "America/Chicago" }),
      client,
      clock: new FakeClock(installedAt),
    });

    expect(shop).toMatchObject({
      shopDomain: "fixture.myshopify.com",
      installedAt,
      reconcileCursor: installedAt,
      timezone: "America/Chicago",
      trialEndsAt: new Date("2026-08-03T12:00:00.000Z"),
    });
    expect(upsert).toHaveBeenCalledOnce();
  });
});
