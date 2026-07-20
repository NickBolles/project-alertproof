import { describe, expect, it } from "vitest";
import { createAdapters } from "../../app/lib/adapters/index.server";
import { FakeClock } from "../../app/lib/adapters/clock/fake.server";
import { parseEnv } from "../../app/lib/env.server";
import { validEnv } from "../helpers/env";
import { MemoryOutbox, MemoryShopPlanStore } from "../helpers/memory";

const dependencies = () => ({
  outbox: new MemoryOutbox(),
  planStore: new MemoryShopPlanStore(),
  clock: new FakeClock(new Date("2026-07-20T12:00:00.000Z")),
});

describe("adapter factory", () => {
  it("selects mocks when external credentials are absent", () => {
    const adapters = createAdapters(parseEnv(validEnv), dependencies());
    expect(adapters.email.kind).toBe("mock");
    expect(adapters.sms.kind).toBe("mock");
    expect(adapters.shopifyAdmin.kind).toBe("mock");
    expect(adapters.billing.kind).toBe("mock");
    expect(adapters.chatFor("slack", "mock://ops").kind).toBe("mock");
  });

  it("selects typed real stubs when complete credentials are present", () => {
    const config = parseEnv({
      ...validEnv,
      SHOPIFY_API_KEY: "real-key",
      SHOPIFY_API_SECRET: "real-secret",
      POSTMARK_API_TOKEN: "postmark-token",
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "twilio-token",
      TWILIO_FROM_NUMBER: "+15555550123",
    });
    const adapters = createAdapters(config, dependencies());
    expect(adapters.email.kind).toBe("postmark");
    expect(adapters.sms.kind).toBe("twilio");
    expect(adapters.shopifyAdmin.kind).toBe("shopify");
    expect(adapters.billing.kind).toBe("shopify");
    expect(adapters.chatFor("slack", "https://hooks.slack.com/test").kind).toBe(
      "slack",
    );
    expect(
      adapters.chatFor("discord", "https://discord.com/api/webhooks/test").kind,
    ).toBe("discord");
  });

  it("FORCE_MOCKS overrides every configured credential", () => {
    const config = parseEnv({
      ...validEnv,
      ALERTPROOF_FORCE_MOCKS: "1",
      SHOPIFY_API_KEY: "real-key",
      SHOPIFY_API_SECRET: "real-secret",
      POSTMARK_API_TOKEN: "postmark-token",
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "twilio-token",
      TWILIO_FROM_NUMBER: "+15555550123",
    });
    const adapters = createAdapters(config, dependencies());
    expect(adapters.mode).toEqual({
      email: "mock",
      chat: "mock",
      sms: "mock",
      shopifyAdmin: "mock",
      billing: "mock",
    });
  });
});
