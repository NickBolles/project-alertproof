import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { RuleForm } from "../components/RuleForm";
import prisma from "../db.server";
import { authenticateAdmin } from "../lib/auth.server";
import { saveRule } from "../lib/ui/forms.server";
import {
  featuresForShop,
  ruleCapacityForPlan,
  effectivePlanForShop,
} from "../lib/billing/plans.server";
import { isAuthBypassArmed } from "../lib/auth-bypass.server";
import { env } from "../lib/env.server";

async function context(request: Request) {
  const { session } = await authenticateAdmin(request);
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });
  return shop;
}
export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await context(request);
  const ruleCount = await prisma.rule.count({ where: { shopId: shop.id } });
  return {
    recipients: await prisma.recipient.findMany({
      where: { shopId: shop.id },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    allowedChannels: featuresForShop(shop).channels,
    canCreate: ruleCapacityForPlan(effectivePlanForShop(shop), ruleCount)
      .allowed,
    authBypass: isAuthBypassArmed(env),
  };
}
export async function action({ request }: ActionFunctionArgs) {
  const shop = await context(request);
  const result = await saveRule(shop.id, await request.formData());
  return result.ok ? redirect(`/app/rules/${result.id}`) : result;
}
export default function NewRulePage() {
  const { recipients, allowedChannels, canCreate, authBypass } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  return (
    <s-page heading="Create rule">
      <s-section>
        {!canCreate ? (
          <s-banner tone="warning">
            Your plan&apos;s rule limit is reached.{" "}
            <a href="/app/billing">Upgrade to add more rules.</a>
          </s-banner>
        ) : null}
        <RuleForm
          recipients={recipients}
          allowedChannels={allowedChannels}
          authBypass={authBypass}
          errors={result && "errors" in result ? result.errors : undefined}
        />
      </s-section>
    </s-page>
  );
}
