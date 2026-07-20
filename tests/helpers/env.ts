export const validEnv = {
  NODE_ENV: "test",
  SHOPIFY_API_KEY: "dev-key",
  SHOPIFY_API_SECRET: "dev-secret",
  SHOPIFY_APP_URL: "http://localhost:3000",
  SCOPES: "read_orders,write_orders,read_products,read_inventory",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/alertproof_test",
  CRON_SECRET: "0123456789abcdef",
  ALERTPROOF_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  ALERTPROOF_FORCE_MOCKS: "0",
  ALERTPROOF_AUTH_BYPASS: "0",
  DISABLE_WORKER: "1",
} satisfies Record<string, string>;
