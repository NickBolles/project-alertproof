import { afterAll, describe, expect, it } from "vitest";
import prisma from "../../app/db.server";

const integration = describe.skipIf(!process.env.TEST_DATABASE_URL);

integration("PostgreSQL schema", () => {
  afterAll(() => prisma.$disconnect());

  it("has the Phase 0 tables after migrations", async () => {
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;
    const names = rows.map((row: { table_name: string }) => row.table_name);
    expect(names).toContain("Shop");
    expect(names).toContain("WebhookEvent");
    expect(names).toContain("MockOutbox");
    expect(await prisma.shop.count()).toBeGreaterThanOrEqual(1);
    expect(await prisma.rule.count()).toBeGreaterThanOrEqual(3);
    expect(await prisma.recipient.count()).toBeGreaterThanOrEqual(2);
  });
});
