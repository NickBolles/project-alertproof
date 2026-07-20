import prisma from "../app/db.server";
import { enqueueWebhook } from "../app/lib/ingest/enqueue.server";
import { processPending } from "../app/lib/ingest/processor.server";
import { registerRuleTopicHandlers } from "../app/lib/rules/handlers.server";

if (
  process.env.ALERTPROOF_PERF_TEST !== "1" ||
  process.env.NODE_ENV === "production"
) {
  throw new Error(
    "Perf sanity is opt-in and requires ALERTPROOF_PERF_TEST=1 on a disposable non-production DATABASE_URL",
  );
}

const shopDomain = "perf-sanity.myshopify.com";
const total = 500;
const acknowledgementMs: number[] = [];
registerRuleTopicHandlers();

async function main() {
  await prisma.shop.deleteMany({ where: { shopDomain } });
  for (let offset = 0; offset < total; offset += 25) {
    await Promise.all(
      Array.from({ length: Math.min(25, total - offset) }, async (_, index) => {
        const sequence = offset + index;
        const started = performance.now();
        await enqueueWebhook(
          {
            shopDomain,
            topic: "orders/create",
            shopifyWebhookId: `perf:${sequence}`,
            payload: {
              id: `perf-order-${sequence}`,
              name: `#PERF-${sequence}`,
              total_price: "10.00",
              line_items: [],
            },
          },
          prisma,
        );
        acknowledgementMs.push(performance.now() - started);
      }),
    );
  }

  const drainStarted = performance.now();
  let processed = 0;
  let claimed: number;
  do {
    const result = await processPending({ client: prisma, batchSize: 100 });
    processed += result.processed;
    claimed = result.claimed;
  } while (claimed > 0);
  const drainMs = performance.now() - drainStarted;
  acknowledgementMs.sort((left, right) => left - right);
  const p50 = acknowledgementMs[Math.floor(acknowledgementMs.length / 2)] ?? 0;
  const summary = { events: total, processed, ingestP50Ms: p50, drainMs };
  console.info(JSON.stringify(summary));
  if (processed !== total)
    throw new Error(`Expected ${total} events, processed ${processed}`);
  if (drainMs >= 60_000)
    throw new Error(`Queue drain exceeded 60s: ${drainMs}ms`);
  if (p50 >= 150) throw new Error(`Ingest p50 exceeded 150ms: ${p50}ms`);
  await prisma.shop.deleteMany({ where: { shopDomain } });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
