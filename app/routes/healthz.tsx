import prisma from "../db.server";

export async function loader() {
  const deadWebhookEvents = await prisma.webhookEvent.count({
    where: { status: "DEAD" },
  });
  return Response.json(
    { ok: deadWebhookEvents === 0, deadWebhookEvents },
    { status: deadWebhookEvents === 0 ? 200 : 503 },
  );
}
