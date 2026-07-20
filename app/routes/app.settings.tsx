import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { z } from "zod";
import prisma from "../db.server";
import { createAdapters } from "../lib/adapters/index.server";
import { authenticateAdmin } from "../lib/auth.server";

const settingsSchema = z.object({
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
  };
}
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticateAdmin(request);
  const parsed = settingsSchema.safeParse(
    Object.fromEntries(await request.formData()),
  );
  if (!parsed.success)
    return { ok: false as const, error: parsed.error.issues[0].message };
  await prisma.shop.update({
    where: { shopDomain: session.shop },
    data: { timezone: parsed.data.timezone },
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
          <s-button type="submit" variant="primary">
            Save
          </s-button>
        </Form>
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
