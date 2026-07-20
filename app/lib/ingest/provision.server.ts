import type { PrismaClient } from "@prisma/client";
import prisma from "../../db.server";
import type { Clock, ShopifyAdmin } from "../ports";

const TRIAL_DAYS = 14;

export async function provisionShop(input: {
  shopDomain: string;
  shopifyAdmin: ShopifyAdmin;
  client?: PrismaClient;
  clock?: Clock;
}) {
  const client = input.client ?? prisma;
  const installedAt = input.clock?.now() ?? new Date();
  const trialEndsAt = new Date(installedAt);
  trialEndsAt.setUTCDate(trialEndsAt.getUTCDate() + TRIAL_DAYS);

  let timezone = "UTC";
  try {
    timezone = await input.shopifyAdmin.getShopTimezone(input.shopDomain);
  } catch (error) {
    console.error("Unable to fetch shop timezone; using UTC", {
      shopDomain: input.shopDomain,
      error,
    });
  }

  return client.shop.upsert({
    where: { shopDomain: input.shopDomain },
    update: { timezone, uninstalledAt: null },
    create: {
      shopDomain: input.shopDomain,
      installedAt,
      trialEndsAt,
      reconcileCursor: installedAt,
      timezone,
    },
  });
}
