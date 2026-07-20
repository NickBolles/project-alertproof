import { Channel, Prisma, Trigger, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import prisma from "../../db.server";
import { encryptSecret } from "../crypto.server";
import { env } from "../env.server";
import {
  effectivePlanForShop,
  featuresForShop,
  ruleCapacityForPlan,
} from "../billing/plans.server";

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);

export const recipientInputSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1, "Name is required").max(100),
  email: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().email().optional(),
  ),
  slackWebhookUrl: optionalUrl,
  discordWebhookUrl: optionalUrl,
  phoneE164: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/, "Use E.164 format")
      .optional(),
  ),
  digestEnabled: z.boolean().default(false),
  digestHourLocal: z.coerce.number().int().min(0).max(23).default(8),
});

const triggerSchema = z.nativeEnum(Trigger);
const channelSchema = z.nativeEnum(Channel);

export const ruleInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().trim().min(1, "Name is required").max(120),
    trigger: triggerSchema,
    enabled: z.boolean(),
    minValue: z.string().trim().optional(),
    stockThreshold: z.string().trim().optional(),
    productIds: z.string().optional(),
    collectionIds: z.string().optional(),
    escalationAfterMinutes: z.string().trim().optional(),
    escalationChannel: channelSchema.optional(),
    routes: z.array(
      z.object({ recipientId: z.string().min(1), channel: channelSchema }),
    ),
  })
  .superRefine((value, context) => {
    if (
      value.trigger === Trigger.ORDER_VALUE_GTE &&
      (!value.minValue || !/^\d+(?:\.\d{1,2})?$/.test(value.minValue))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minValue"],
        message: "Enter a non-negative amount with up to two decimals",
      });
    }
    if (
      value.trigger === Trigger.LOW_STOCK &&
      !/^-?\d+$/.test(value.stockThreshold ?? "")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stockThreshold"],
        message: "Enter a whole-number stock threshold",
      });
    }
    if (value.routes.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["routes"],
        message: "Select at least one recipient and channel",
      });
    }
    if (
      Boolean(value.escalationAfterMinutes) !== Boolean(value.escalationChannel)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["escalationAfterMinutes"],
        message: "Set both an escalation delay and backup channel",
      });
    }
    if (
      value.escalationAfterMinutes &&
      (!/^\d+$/.test(value.escalationAfterMinutes) ||
        Number(value.escalationAfterMinutes) < 1 ||
        Number(value.escalationAfterMinutes) > 10_080)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["escalationAfterMinutes"],
        message: "Escalation delay must be between 1 minute and 7 days",
      });
    }
  });

export type FormResult =
  { ok: true; id: string } | { ok: false; errors: Record<string, string[]> };

function errors(error: z.ZodError): FormResult {
  return {
    ok: false,
    errors: Object.fromEntries(
      Object.entries(error.flatten().fieldErrors).filter(
        (entry): entry is [string, string[]] => Boolean(entry[1]),
      ),
    ),
  };
}

function strings(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function saveRecipient(
  shopId: string,
  form: FormData,
  client: PrismaClient = prisma,
  now = new Date(),
): Promise<FormResult> {
  const parsed = recipientInputSchema.safeParse({
    ...Object.fromEntries(form),
    digestEnabled: form.get("digestEnabled") === "true",
  });
  if (!parsed.success) return errors(parsed.error);
  const value = parsed.data;
  const shop = await client.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: { plan: true, trialEndsAt: true },
  });
  if (value.digestEnabled && !featuresForShop(shop, now).digest) {
    return {
      ok: false,
      errors: { digestEnabled: ["Daily digests require the Pro plan"] },
    };
  }
  if (
    !value.email &&
    !value.slackWebhookUrl &&
    !value.discordWebhookUrl &&
    !value.phoneE164
  ) {
    return {
      ok: false,
      errors: { email: ["Configure at least one destination"] },
    };
  }
  const secret = (raw?: string) =>
    raw ? encryptSecret(raw, env.ALERTPROOF_ENCRYPTION_KEY) : null;
  const data = {
    name: value.name,
    email: value.email ?? null,
    slackWebhookUrlEnc: secret(value.slackWebhookUrl),
    discordWebhookUrlEnc: secret(value.discordWebhookUrl),
    phoneE164: value.phoneE164 ?? null,
    digestEnabled: value.digestEnabled,
    digestHourLocal: value.digestHourLocal,
  };
  const row = value.id
    ? await client.recipient.update({ where: { id: value.id, shopId }, data })
    : await client.recipient.create({ data: { ...data, shopId } });
  return { ok: true, id: row.id };
}

export async function saveRule(
  shopId: string,
  form: FormData,
  client: PrismaClient = prisma,
  now = new Date(),
): Promise<FormResult> {
  const routes = form.getAll("routes").flatMap((raw) => {
    const [recipientId, channel] = String(raw).split(":");
    const parsed = channelSchema.safeParse(channel);
    return recipientId && parsed.success
      ? [{ recipientId, channel: parsed.data }]
      : [];
  });
  const parsed = ruleInputSchema.safeParse({
    ...Object.fromEntries(form),
    enabled: form.get("enabled") !== "false",
    routes,
  });
  if (!parsed.success) return errors(parsed.error);
  const value = parsed.data;
  const shop = await client.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: {
      plan: true,
      trialEndsAt: true,
      _count: { select: { rules: true } },
    },
  });
  if (value.escalationAfterMinutes && !featuresForShop(shop, now).escalation) {
    return {
      ok: false,
      errors: {
        escalationAfterMinutes: ["Escalation requires the Pro plan"],
      },
    };
  }
  if (!value.id) {
    const capacity = ruleCapacityForPlan(
      effectivePlanForShop(shop, now),
      shop._count.rules,
    );
    if (!capacity.allowed) {
      return {
        ok: false,
        errors: {
          name: [
            `Your plan allows ${capacity.maxRules} rule. Upgrade to create another.`,
          ],
        },
      };
    }
  }
  const conditions: Record<string, Prisma.InputJsonValue> = {};
  if (value.trigger === Trigger.ORDER_VALUE_GTE)
    conditions.minValue = value.minValue!;
  if (value.trigger === Trigger.LOW_STOCK)
    conditions.stockThreshold = Number(value.stockThreshold);
  if (value.trigger === Trigger.PRODUCT_ORDERED) {
    conditions.productIds = strings(value.productIds);
    conditions.collectionIds = strings(value.collectionIds);
  }
  const grouped = new Map<string, Channel[]>();
  for (const route of value.routes) {
    grouped.set(route.recipientId, [
      ...(grouped.get(route.recipientId) ?? []),
      route.channel,
    ]);
  }
  const id = await client.$transaction(async (tx) => {
    const rule = value.id
      ? await tx.rule.update({
          where: { id: value.id, shopId },
          data: {
            name: value.name,
            trigger: value.trigger,
            enabled: value.enabled,
            conditions,
            escalation:
              value.escalationAfterMinutes && value.escalationChannel
                ? {
                    afterMinutes: Number(value.escalationAfterMinutes),
                    channel: value.escalationChannel,
                  }
                : Prisma.DbNull,
          },
        })
      : await tx.rule.create({
          data: {
            shopId,
            name: value.name,
            trigger: value.trigger,
            enabled: value.enabled,
            conditions,
            escalation:
              value.escalationAfterMinutes && value.escalationChannel
                ? {
                    afterMinutes: Number(value.escalationAfterMinutes),
                    channel: value.escalationChannel,
                  }
                : undefined,
          },
        });
    await tx.ruleRecipient.deleteMany({ where: { ruleId: rule.id } });
    await tx.ruleRecipient.createMany({
      data: [...grouped].map(([recipientId, channels]) => ({
        ruleId: rule.id,
        recipientId,
        channels,
      })),
    });
    return rule.id;
  });
  return { ok: true, id };
}
