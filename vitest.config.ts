import { defineConfig } from "vitest/config";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??=
  "postgresql://alertproof:alertproof@localhost:5432/alertproof_test?schema=public";
process.env.CRON_SECRET ??= "alertproof-test-cron-secret";
process.env.ALERTPROOF_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
process.env.ALERTPROOF_FORCE_MOCKS ??= "1";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    restoreMocks: true,
    clearMocks: true,
  },
});
