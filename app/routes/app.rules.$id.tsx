import type { Channel } from "@prisma/client";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { RuleForm } from "../components/RuleForm";
import prisma from "../db.server";
import { authenticateAdmin } from "../lib/auth.server";
import { saveRule } from "../lib/ui/forms.server";
import { featuresForShop } from "../lib/billing/plans.server";
import { isAuthBypassArmed } from "../lib/auth-bypass.server";
import { env } from "../lib/env.server";

async function context(request: Request) {
  const { session } = await authenticateAdmin(request);
  return prisma.shop.findUniqueOrThrow({ where: { shopDomain: session.shop } });
}
export async function loader({ request, params }: LoaderFunctionArgs) {
  const shop = await context(request);
  const [rule, recipients] = await Promise.all([
    prisma.rule.findFirstOrThrow({
      where: { id: params.id, shopId: shop.id },
      include: { recipients: true },
    }),
    prisma.recipient.findMany({
      where: { shopId: shop.id },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return {
    rule: {
      id: rule.id,
      name: rule.name,
      trigger: rule.trigger,
      enabled: rule.enabled,
      conditions: rule.conditions as Record<string, unknown>,
      routes: rule.recipients,
      escalation: rule.escalation as {
        afterMinutes: number;
        channel: Channel;
      } | null,
    },
    recipients,
    allowedChannels: featuresForShop(shop).channels,
    escalationAllowed: featuresForShop(shop).escalation,
    authBypass: isAuthBypassArmed(env),
  };
}
export async function action({ request, params }: ActionFunctionArgs) {
  const shop = await context(request);
  const form = await request.formData();
  if (form.get("intent") === "delete") {
    await prisma.rule.delete({ where: { id: params.id, shopId: shop.id } });
    return redirect("/app/rules");
  }
  if (form.get("id") !== params.id)
    return Response.json({ error: "Rule ID mismatch" }, { status: 400 });
  const result = await saveRule(shop.id, form);
  return result.ok ? redirect(`/app/rules/${result.id}`) : result;
}
export default function EditRulePage() {
  const { rule, recipients, allowedChannels, escalationAllowed, authBypass } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  return (
    <s-page heading="Edit rule">
      <s-section>
        <RuleForm
          recipients={recipients}
          value={rule}
          allowedChannels={allowedChannels}
          escalationAllowed={escalationAllowed}
          authBypass={authBypass}
          errors={result && "errors" in result ? result.errors : undefined}
        />
      </s-section>
      <form method="post">
        <input type="hidden" name="intent" value="delete" />
        <s-button type="submit" tone="critical">
          Delete rule
        </s-button>
      </form>
    </s-page>
  );
}
