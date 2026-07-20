import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import prisma from "../db.server";
import { authenticateAdmin } from "../lib/auth.server";
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
        _count: { select: { rules: true } },
      },
    }),
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
  return saveRecipient(shop.id, form);
}

export default function RecipientsPage() {
  const { recipients } = useLoaderData<typeof loader>();
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
                · {recipient._count.rules} rules
              </s-paragraph>
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
