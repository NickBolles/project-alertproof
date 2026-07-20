import type { Env } from "./env.server";

export type AuthBypassConfig = Pick<
  Env,
  | "NODE_ENV"
  | "ALERTPROOF_AUTH_BYPASS"
  | "AUTH_MODE"
  | "SHOPIFY_API_KEY"
  | "SHOPIFY_API_SECRET"
>;

/** Development auth is an explicit allowlist and can never arm in production. */
export function isAuthBypassArmed(config: AuthBypassConfig): boolean {
  return (
    (config.NODE_ENV === "development" || config.NODE_ENV === "test") &&
    config.AUTH_MODE === "mock" &&
    config.ALERTPROOF_AUTH_BYPASS &&
    config.SHOPIFY_API_KEY === "dev-key" &&
    config.SHOPIFY_API_SECRET === "dev-secret"
  );
}
