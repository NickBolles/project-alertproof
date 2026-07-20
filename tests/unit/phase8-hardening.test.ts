import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { logger } from "../../app/lib/logger.server";

describe("Phase 8 operational hardening", () => {
  it("emits structured JSON logs while redacting secrets and destinations", () => {
    const previousLogLevel = process.env.ALERTPROOF_LOG_LEVEL;
    delete process.env.ALERTPROOF_LOG_LEVEL;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      logger.info("delivery.test", {
        deliveryId: "delivery-1",
        authToken: "do-not-log",
        destination: "+13125550100",
        nested: { password: "also-secret", safe: "visible" },
      });
      const record = JSON.parse(String(info.mock.calls[0][0])) as Record<
        string,
        unknown
      >;
      expect(record).toMatchObject({
        level: "info",
        event: "delivery.test",
        deliveryId: "delivery-1",
        authToken: "[REDACTED]",
        destination: "[REDACTED]",
        nested: { password: "[REDACTED]", safe: "visible" },
      });
      expect(record.timestamp).toEqual(expect.any(String));
      expect(info.mock.calls[0][0]).not.toContain("do-not-log");
    } finally {
      if (previousLogLevel === undefined)
        delete process.env.ALERTPROOF_LOG_LEVEL;
      else process.env.ALERTPROOF_LOG_LEVEL = previousLogLevel;
    }
  });

  it("ships deploy, runbook, and opt-in performance artifacts", () => {
    const root = process.cwd();
    for (const file of [
      "Dockerfile",
      "fly.toml",
      "docs/GOING_LIVE.md",
      "scripts/perf-sanity.ts",
    ]) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }
    const packageJson = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["perf:sanity"]).toContain("perf-sanity.ts");
    expect(readFileSync(join(root, "docs/GOING_LIVE.md"), "utf8")).toContain(
      "ALERTPROOF_ENCRYPTION_KEY",
    );
  });
});
