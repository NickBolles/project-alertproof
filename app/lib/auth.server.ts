import { authenticate } from "../shopify.server";
import { env } from "./env.server";
import { isAuthBypassArmed } from "./auth-bypass.server";

export type AdminSession = { shop: string };

export async function authenticateAdmin(request: Request): Promise<{
  session: AdminSession;
}> {
  if (isAuthBypassArmed(env)) {
    return { session: { shop: env.DEV_SHOP_DOMAIN } };
  }
  const result = await authenticate.admin(request);
  return { session: { shop: result.session.shop } };
}
