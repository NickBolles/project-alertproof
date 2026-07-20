import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { DashboardView } from "../../app/routes/app._index";
import { DeliveryLogView } from "../../app/routes/app.log._index";
import { SettingsView } from "../../app/routes/app.settings";
import { isAuthBypassArmed } from "../../app/lib/auth-bypass.server";
import {
  recipientInputSchema,
  ruleInputSchema,
} from "../../app/lib/ui/forms.server";

const baseAuth = {
  NODE_ENV: "development" as const,
  ALERTPROOF_AUTH_BYPASS: true,
  AUTH_MODE: "mock" as const,
  SHOPIFY_API_KEY: "dev-key",
  SHOPIFY_API_SECRET: "dev-secret",
};

describe("Phase 5 embedded UI", () => {
  it("arms auth bypass only for explicit non-production placeholder config", () => {
    expect(isAuthBypassArmed(baseAuth)).toBe(true);
    expect(
      isAuthBypassArmed({ ...baseAuth, ALERTPROOF_AUTH_BYPASS: false }),
    ).toBe(false);
    expect(isAuthBypassArmed({ ...baseAuth, AUTH_MODE: "shopify" })).toBe(
      false,
    );
    expect(
      isAuthBypassArmed({ ...baseAuth, SHOPIFY_API_SECRET: "real-secret" }),
    ).toBe(false);
    expect(isAuthBypassArmed({ ...baseAuth, NODE_ENV: "production" })).toBe(
      false,
    );
    expect(
      isAuthBypassArmed({ ...baseAuth, NODE_ENV: undefined as never }),
    ).toBe(false);
  });

  it("validates recipient and conditional rule fields server-side", () => {
    expect(
      recipientInputSchema.safeParse({ name: "", email: "bad" }).success,
    ).toBe(false);
    expect(
      ruleInputSchema.safeParse({
        name: "Value",
        trigger: "ORDER_VALUE_GTE",
        enabled: true,
        minValue: "oops",
        routes: [],
      }).success,
    ).toBe(false);
    expect(
      ruleInputSchema.safeParse({
        name: "Orders",
        trigger: "ORDER_CREATED",
        enabled: true,
        routes: [{ recipientId: "r1", channel: "EMAIL" }],
      }).success,
    ).toBe(true);
  });

  it("smoke-renders dashboard, delivery log, and settings routes", () => {
    const render = (component: ReturnType<typeof createElement>) => {
      const router = createMemoryRouter([{ path: "/", element: component }]);
      return renderToStaticMarkup(createElement(RouterProvider, { router }));
    };
    const dashboard = render(
      createElement(DashboardView, {
        data: {
          shopDomain: "test.myshopify.com",
          deadWebhookEvents: 1,
          ruleCount: 1,
          recipientCount: 1,
          testRun: true,
          alertsSent7d: 3,
          deliveryRate: 100,
          lastMissedCount: 0,
          mode: {
            email: "mock",
            chat: "mock",
            sms: "mock",
            shopifyAdmin: "mock",
            billing: "mock",
          } as never,
        } as never,
      }),
    );
    const log = render(
      createElement(DeliveryLogView, {
        data: {
          shopDomain: "test.myshopify.com",
          alerts: [],
          filters: { order: "", status: "", channel: "", from: "" },
          nextCursor: null,
        } as never,
      }),
    );
    const settings = render(
      createElement(SettingsView, {
        data: {
          shopDomain: "test.myshopify.com",
          timezone: "UTC",
          mode: {
            email: "mock",
            chat: "mock",
            sms: "mock",
            shopifyAdmin: "mock",
            billing: "mock",
          },
        } as never,
      }),
    );
    expect(dashboard).toContain("Onboarding checklist");
    expect(dashboard).toContain("Test my alerts");
    expect(log).toContain("Delivery log");
    expect(settings).toContain("Connections");
  });
});
