import { getHealthSnapshot, type HealthSnapshot } from "../lib/health.server";

export async function loader() {
  try {
    const health = await getHealthSnapshot();
    return Response.json(health, { status: health.ok ? 200 : 503 });
  } catch {
    return Response.json(
      {
        ok: false,
        database: { ok: false },
        queue: { depth: 0, dead: 0, oldestPendingAgeSeconds: null },
      } satisfies HealthSnapshot,
      { status: 503 },
    );
  }
}
