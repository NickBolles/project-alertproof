import "dotenv/config";
import { z } from "zod";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);
const optionalString = z.preprocess(
  emptyToUndefined,
  z.string().min(1).optional(),
);
const flag = z
  .enum(["0", "1"])
  .default("0")
  .transform((value) => value === "1");

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    SHOPIFY_API_KEY: z.string().min(1).default("dev-key"),
    SHOPIFY_API_SECRET: z.string().min(1).default("dev-secret"),
    SHOPIFY_APP_URL: z.string().url().default("http://localhost:3000"),
    SCOPES: z
      .string()
      .min(1)
      .default("read_orders,write_orders,read_products,read_inventory"),
    DATABASE_URL: z
      .string({ required_error: "DATABASE_URL is required" })
      .min(1, "DATABASE_URL is required"),
    TEST_DATABASE_URL: optionalString,
    POSTMARK_API_TOKEN: optionalString,
    POSTMARK_WEBHOOK_SECRET: optionalString,
    EMAIL_FROM: z.string().email().default("alerts@alertproof.test"),
    TWILIO_ACCOUNT_SID: optionalString,
    TWILIO_AUTH_TOKEN: optionalString,
    TWILIO_FROM_NUMBER: optionalString,
    CRON_SECRET: z
      .string({ required_error: "CRON_SECRET is required" })
      .min(16, "CRON_SECRET must be at least 16 characters"),
    ALERTPROOF_ENCRYPTION_KEY: z
      .string({ required_error: "ALERTPROOF_ENCRYPTION_KEY is required" })
      .refine((value) => {
        try {
          return Buffer.from(value, "base64").length === 32;
        } catch {
          return false;
        }
      }, "ALERTPROOF_ENCRYPTION_KEY must be a base64-encoded 32-byte key"),
    ALERTPROOF_FORCE_MOCKS: flag,
    ALERTPROOF_AUTH_BYPASS: flag,
    AUTH_MODE: z.enum(["shopify", "mock"]).default("shopify"),
    DEV_SHOP_DOMAIN: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)
      .default("alertproof-dev.myshopify.com"),
    DISABLE_WORKER: flag,
    SHOP_CUSTOM_DOMAIN: optionalString,
    SHOPIFY_APP_PRICING_URL: z.preprocess(
      emptyToUndefined,
      z.string().url().optional(),
    ),
  })
  .superRefine((value, context) => {
    const twilioValues = [
      value.TWILIO_ACCOUNT_SID,
      value.TWILIO_AUTH_TOKEN,
      value.TWILIO_FROM_NUMBER,
    ];
    if (twilioValues.some(Boolean) && !twilioValues.every(Boolean)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TWILIO_ACCOUNT_SID"],
        message: "Twilio credentials must be configured together",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export type AdapterMode = {
  email: "mock" | "postmark";
  chat: "mock" | "webhook";
  sms: "mock" | "twilio";
  shopifyAdmin: "mock" | "shopify";
  billing: "mock" | "shopify";
};

export function parseEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(
        (issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`,
      )
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}

export function getAdapterMode(config: Env): AdapterMode {
  const forced = config.ALERTPROOF_FORCE_MOCKS;
  const hasRealShopifyCredentials =
    config.SHOPIFY_API_KEY !== "dev-key" &&
    config.SHOPIFY_API_SECRET !== "dev-secret";

  return {
    email: !forced && config.POSTMARK_API_TOKEN ? "postmark" : "mock",
    chat: forced ? "mock" : "webhook",
    sms:
      !forced &&
      config.TWILIO_ACCOUNT_SID &&
      config.TWILIO_AUTH_TOKEN &&
      config.TWILIO_FROM_NUMBER
        ? "twilio"
        : "mock",
    shopifyAdmin: !forced && hasRealShopifyCredentials ? "shopify" : "mock",
    billing: !forced && hasRealShopifyCredentials ? "shopify" : "mock",
  };
}

export const env = parseEnv(process.env);
export const mode = getAdapterMode(env);
