import { Plan } from "@prisma/client";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData } from "react-router";
import prisma from "../db.server";
import { createAdapters } from "../lib/adapters/index.server";
import { authenticateAdmin } from "../lib/auth.server";
import {
  effectivePlanForShop,
  PLAN_FEATURES,
} from "../lib/billing/plans.server";
import { env } from "../lib/env.server";
import { isAuthBypassArmed } from "../lib/auth-bypass.server";
import { PrismaShopPlanStore } from "../lib/adapters/outbox.server";
import { reconcileShopSubscription } from "../lib/billing/subscriptions.server";

async function billingContext(request: Request) {
  const { session } = await authenticateAdmin(request);
  let shop = await prisma.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });
  const adapters = createAdapters();
  if (adapters.shopifyAdmin.kind === "shopify") {
    await reconcileShopSubscription({
      shopId: shop.id,
      shopDomain: shop.shopDomain,
      shopifyAdmin: adapters.shopifyAdmin,
      planStore: new PrismaShopPlanStore(prisma),
    });
    shop = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
  }
  return { shop, billing: adapters.billing };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { shop, billing } = await billingContext(request);
  const now = new Date();
  return {
    currentPlan: shop.plan,
    effectivePlan: effectivePlanForShop(shop, now),
    trialEndsAt: shop.trialEndsAt?.toISOString() ?? null,
    billingMode: billing.kind,
    mockUpgradeEnabled:
      billing.kind === "mock" &&
      env.ALERTPROOF_FORCE_MOCKS &&
      isAuthBypassArmed(env),
    plans: Object.entries(PLAN_FEATURES).map(([id, features]) => ({
      id: id as Plan,
      ...features,
    })),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { shop, billing } = await billingContext(request);
  const form = await request.formData();
  const plan = String(form.get("plan"));
  if (plan !== Plan.STANDARD && plan !== Plan.PRO) {
    return Response.json(
      { ok: false as const, error: "Select Standard or Pro" },
      { status: 400 },
    );
  }
  const returnUrl = new URL("/app/billing", request.url).toString();
  if (billing.kind === "mock") {
    if (!env.ALERTPROOF_FORCE_MOCKS || !isAuthBypassArmed(env)) {
      return Response.json(
        {
          ok: false as const,
          error:
            "Mock billing is available only in guarded mock-auth development mode",
        },
        { status: 403 },
      );
    }
    const subscription = await billing.requestSubscription({
      shopId: shop.id,
      plan,
      returnUrl,
    });
    return {
      ok: true as const,
      plan,
      confirmationUrl: subscription.confirmationUrl,
    };
  }
  const subscription = await billing.requestSubscription({
    shopId: shop.id,
    plan,
    returnUrl,
  });
  return redirect(subscription.confirmationUrl);
}

export default function BillingPage() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  return (
    <s-page heading="Plans">
      {data.trialEndsAt &&
      data.effectivePlan === Plan.STANDARD &&
      data.currentPlan === Plan.FREE ? (
        <s-banner tone="info">
          Your Standard trial runs through{" "}
          {new Date(data.trialEndsAt).toLocaleDateString()}.
        </s-banner>
      ) : null}
      {result && "ok" in result && result.ok ? (
        <s-banner tone="success">
          {result.plan} is active in mock billing.
        </s-banner>
      ) : null}
      <s-section heading={`Current plan: ${data.currentPlan}`}>
        <s-paragraph>
          Billing mode:{" "}
          {data.mockUpgradeEnabled
            ? "MOCK — upgrades activate instantly"
            : data.billingMode === "shopify"
              ? "Shopify App Pricing"
              : "Mock billing locked; use guarded mock-auth development mode"}
        </s-paragraph>
      </s-section>
      {data.plans.map((plan) => (
        <s-section
          key={plan.id}
          heading={`${plan.name} — $${plan.monthlyPriceUsd}/month`}
        >
          <s-paragraph>
            {plan.maxRules === null
              ? "Unlimited rules"
              : `${plan.maxRules} rule`}{" "}
            · {plan.channels.join(", ")} ·{" "}
            {plan.retentionDays === null
              ? "Unlimited retention"
              : `${plan.retentionDays}-day retention`}
          </s-paragraph>
          <s-paragraph>
            {plan.ordersPerMonth === null
              ? "Unlimited orders"
              : `${plan.ordersPerMonth} orders/month`}
            {plan.escalation ? " · Escalation" : ""}
            {plan.digest ? " · Daily digest" : ""}
          </s-paragraph>
          {plan.id === Plan.FREE || plan.id === data.currentPlan ? null : (
            <Form method="post">
              <input type="hidden" name="plan" value={plan.id} />
              <s-button type="submit" variant="primary">
                Choose {plan.name}
              </s-button>
            </Form>
          )}
        </s-section>
      ))}
    </s-page>
  );
}
