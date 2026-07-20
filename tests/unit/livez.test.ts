import { describe, expect, it } from "vitest";
import { loader } from "../../app/routes/livez";

describe("liveness endpoint", () => {
  it("returns success without querying queue or database health", async () => {
    const response = await loader();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
