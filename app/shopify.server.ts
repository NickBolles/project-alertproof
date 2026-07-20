import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { createAdapters } from "./lib/adapters/index.server";
import { env } from "./lib/env.server";
import { provisionShop } from "./lib/ingest/provision.server";
import { isAuthBypassArmed } from "./lib/auth-bypass.server";

if (isAuthBypassArmed(env)) {
  console.warn(
    `[AlertProof] DEVELOPMENT AUTH BYPASS ARMED for ${env.DEV_SHOP_DOMAIN}`,
  );
}

const shopify = shopifyApp({
  apiKey: env.SHOPIFY_API_KEY,
  apiSecretKey: env.SHOPIFY_API_SECRET,
  apiVersion: ApiVersion.July26,
  scopes: env.SCOPES.split(","),
  appUrl: env.SHOPIFY_APP_URL,
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  hooks: {
    afterAuth: async ({ session }) => {
      await provisionShop({
        shopDomain: session.shop,
        shopifyAdmin: createAdapters().shopifyAdmin,
      });
    },
  },
  future: { expiringOfflineAccessTokens: true },
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
