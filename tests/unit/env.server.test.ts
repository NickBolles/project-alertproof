import { describe, expect, it } from "vitest";
import { getAdapterMode, parseEnv } from "../../app/lib/env.server";
import { validEnv } from "../helpers/env";

describe("environment validation", () => {
  it("parses a valid minimal environment with safe defaults", () => {
    const parsed = parseEnv(validEnv);
    expect(parsed.SHOPIFY_API_KEY).toBe("dev-key");
    expect(parsed.EMAIL_FROM).toBe("alerts@alertproof.test");
    expect(parsed.DISABLE_WORKER).toBe(true);
  });

  it("fails loudly when required values are missing", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL is required/);
    expect(() => parseEnv({ ...validEnv, CRON_SECRET: "short" })).toThrow(
      /CRON_SECRET must be at least 16 characters/,
    );
  });

  it("rejects invalid encryption keys and partial Twilio credentials", () => {
    expect(() =>
      parseEnv({ ...validEnv, ALERTPROOF_ENCRYPTION_KEY: "not-a-key" }),
    ).toThrow(/32-byte key/);
    expect(() =>
      parseEnv({ ...validEnv, TWILIO_ACCOUNT_SID: "AC123" }),
    ).toThrow(/Twilio credentials must be configured together/);
  });

  it("reports adapter mode without exposing secrets", () => {
    expect(getAdapterMode(parseEnv(validEnv))).toEqual({
      email: "mock",
      chat: "webhook",
      sms: "mock",
      shopifyAdmin: "mock",
      billing: "mock",
    });
  });
});
