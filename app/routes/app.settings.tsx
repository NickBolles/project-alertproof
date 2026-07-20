import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { z } from "zod";
import prisma from "../db.server";
import { createAdapters } from "../lib/adapters/index.server";
import { authenticateAdmin } from "../lib/auth.server";
import { featuresForShop } from "../lib/billing/plans.server";
import { env } from "../lib/env.server";
import {
  parseShopSettings,
  withEncryptedTwilioCredentials,
} from "../lib/sms/credentials.server";

const optional = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);
const settingsSchema = z
  .object({
    timezone: z
      .string()
      .trim()
      .min(1)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Enter a valid IANA timezone"),
    twilioAccountSid: optional,
    twilioAuthToken: optional,
    twilioFromNumber: optional,
  })
  .superRefine((value, context) => {
    const fields = [
      value.twilioAccountSid,
      value.twilioAuthToken,
      value.twilioFromNumber,
    ];
    if (fields.some(Boolean) && !fields.every(Boolean)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["twilioAccountSid"],
        message:
          "Enter the Twilio account SID, auth token, and from number together",
      });
    }
    if (
      value.twilioFromNumber &&
      !/^\+[1-9]\d{7,14}$/.test(value.twilioFromNumber)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["twilioFromNumber"],
        message: "Twilio from number must use E.164 format",
      });
    }
  });

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticateAdmin(request);
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });
  return {
    shopDomain: shop.shopDomain,
    timezone: shop.timezone,
    mode: createAdapters().mode,
    twilioConfigured:
      typeof parseShopSettings(shop.settings).twilioCredentialsEnc === "string",
    twilioAllowed: featuresForShop(shop).channels.includes("SMS"),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticateAdmin(request);
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });
  const form = await request.formData();
  if (form.get("intent") === "clear-twilio") {
    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        settings: withEncryptedTwilioCredentials(
          shop.settings,
          null,
          env.ALERTPROOF_ENCRYPTION_KEY,
        ),
      },
    });
    return { ok: true as const };
  }
  const parsed = settingsSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0].message };
  }
  const hasCredentials = Boolean(parsed.data.twilioAccountSid);
  if (hasCredentials && !featuresForShop(shop).channels.includes("SMS")) {
    return { ok: false as const, error: "BYO Twilio requires the Pro plan" };
  }
  const settings = hasCredentials
    ? withEncryptedTwilioCredentials(
        shop.settings,
        {
          accountSid: parsed.data.twilioAccountSid!,
          authToken: parsed.data.twilioAuthToken!,
          fromNumber: parsed.data.twilioFromNumber!,
        },
        env.ALERTPROOF_ENCRYPTION_KEY,
      )
    : undefined;
  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      timezone: parsed.data.timezone,
      ...(settings ? { settings } : {}),
    },
  });
  return { ok: true as const };
}

export type SettingsData = Awaited<ReturnType<typeof loader>>;
export function SettingsView({
  data,
  result,
}: {
  data: SettingsData;
  result?: Awaited<ReturnType<typeof action>>;
}) {
  return (
    <s-page heading="Settings">
      <s-section heading="Store">
        {result && !result.ok ? (
          <s-banner tone="critical">{result.error}</s-banner>
        ) : null}
        <Form method="post">
          <s-text-field
            name="timezone"
            label="Timezone"
            value={data.timezone}
          />
          <s-text-field
            name="twilioAccountSid"
            label="Twilio account SID (Pro)"
            disabled={!data.twilioAllowed}
          />
          <s-text-field
            name="twilioAuthToken"
            label="Twilio auth token"
            disabled={!data.twilioAllowed}
          />
          <s-text-field
            name="twilioFromNumber"
            label="Twilio from number (E.164)"
            disabled={!data.twilioAllowed}
          />
          <s-paragraph>
            {data.twilioConfigured
              ? "Merchant Twilio credentials are configured and encrypted. Leave fields blank to keep them."
              : "No merchant Twilio credentials configured; app credentials or mock SMS will be used."}
          </s-paragraph>
          <s-button type="submit" variant="primary">
            Save
          </s-button>
        </Form>
        {data.twilioConfigured ? (
          <Form method="post">
            <input type="hidden" name="intent" value="clear-twilio" />
            <s-button type="submit" tone="critical">
              Remove Twilio credentials
            </s-button>
          </Form>
        ) : null}
        <s-paragraph>Shop: {data.shopDomain}</s-paragraph>
      </s-section>
      <s-section heading="Connections">
        <s-paragraph>Email: {data.mode.email}</s-paragraph>
        <s-paragraph>Chat: {data.mode.chat}</s-paragraph>
        <s-paragraph>SMS: {data.mode.sms}</s-paragraph>
        <s-paragraph>Billing: {data.mode.billing}</s-paragraph>
      </s-section>
    </s-page>
  );
}

export default function SettingsPage() {
  return (
    <SettingsView
      data={useLoaderData<typeof loader>()}
      result={useActionData<typeof action>()}
    />
  );
}
