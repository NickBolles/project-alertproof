import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import prisma from "../db.server";
import { authenticateAdmin } from "../lib/auth.server";
import { featuresForShop } from "../lib/billing/plans.server";
import { saveRecipient } from "../lib/ui/forms.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticateAdmin(request);
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });
  return {
    recipients: await prisma.recipient.findMany({
      where: { shopId: shop.id },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        phoneE164: true,
        slackWebhookUrlEnc: true,
        discordWebhookUrlEnc: true,
        digestEnabled: true,
        digestHourLocal: true,
        _count: { select: { rules: true } },
      },
    }),
    digestAllowed: featuresForShop(shop).digest,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticateAdmin(request);
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });
  const form = await request.formData();
  if (form.get("intent") === "delete") {
    await prisma.recipient.delete({
      where: { id: String(form.get("id")), shopId: shop.id },
    });
    return { ok: true as const, id: String(form.get("id")) };
  }
  if (form.get("intent") === "digest") {
    const enabled = form.get("digestEnabled") === "true";
    const hour = Number(form.get("digestHourLocal"));
    if (enabled && !featuresForShop(shop).digest) {
      return {
        ok: false as const,
        errors: { digestEnabled: ["Daily digests require the Pro plan"] },
      };
    }
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      return {
        ok: false as const,
        errors: { digestHourLocal: ["Digest hour must be from 0 through 23"] },
      };
    }
    const id = String(form.get("id"));
    await prisma.recipient.update({
      where: { id, shopId: shop.id },
      data: { digestEnabled: enabled, digestHourLocal: hour },
    });
    return { ok: true as const, id };
  }
  return saveRecipient(shop.id, form);
}

export default function RecipientsPage() {
  const { recipients, digestAllowed } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  return (
    <s-page heading="Recipients">
      <s-section heading="Add recipient">
        {result && !result.ok ? (
          <s-banner tone="critical">
            Please correct the highlighted recipient fields.
          </s-banner>
        ) : null}
        <Form method="post">
          <s-text-field name="name" label="Name" required />
          <s-text-field name="email" label="Email" />
          <s-text-field name="slackWebhookUrl" label="Slack webhook URL" />
          <s-text-field name="discordWebhookUrl" label="Discord webhook URL" />
          <s-text-field name="phoneE164" label="SMS phone (E.164)" />
          <label>
            <input
              type="checkbox"
              name="digestEnabled"
              value="true"
              disabled={!digestAllowed}
            />
            Send a daily email digest (Pro)
          </label>
          <s-text-field
            name="digestHourLocal"
            label="Digest hour (0-23, store timezone)"
            value="8"
          />
          <s-button type="submit" variant="primary">
            Add recipient
          </s-button>
        </Form>
      </s-section>
      <s-section heading="Configured recipients">
        {recipients.length === 0 ? (
          <s-paragraph>No recipients yet.</s-paragraph>
        ) : (
          recipients.map((recipient) => (
            <div key={recipient.id}>
              <s-heading>{recipient.name}</s-heading>
              <s-paragraph>
                {recipient.email ?? "No email"} ·{" "}
                {recipient.phoneE164 ?? "No SMS"} ·{" "}
                {recipient.slackWebhookUrlEnc ? "Slack configured" : "No Slack"}{" "}
                · {recipient._count.rules} rules ·{" "}
                {recipient.digestEnabled
                  ? `Digest at ${recipient.digestHourLocal}:00`
                  : "No digest"}
              </s-paragraph>
              <Form method="post">
                <input type="hidden" name="intent" value="digest" />
                <input type="hidden" name="id" value={recipient.id} />
                <label>
                  <input
                    type="checkbox"
                    name="digestEnabled"
                    value="true"
                    defaultChecked={recipient.digestEnabled}
                    disabled={!digestAllowed}
                  />
                  Daily digest
                </label>
                <s-text-field
                  name="digestHourLocal"
                  label="Local hour"
                  value={String(recipient.digestHourLocal)}
                />
                <s-button type="submit">Save digest</s-button>
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="delete" />
                <input type="hidden" name="id" value={recipient.id} />
                <s-button type="submit" tone="critical">
                  Delete
                </s-button>
              </Form>
            </div>
          ))
        )}
      </s-section>
    </s-page>
  );
}
