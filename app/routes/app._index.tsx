import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  return {
    deadWebhookEvents: await prisma.webhookEvent.count({
      where: { shopDomain: session.shop, status: "DEAD" },
    }),
  };
}

export default function AppIndex() {
  const { deadWebhookEvents } = useLoaderData<typeof loader>();
  return (
    <s-page heading="AlertProof">
      <s-section heading="Foundation ready">
        <s-paragraph>
          Provider adapters are running in mock mode until credentials are
          configured.
        </s-paragraph>
        <s-paragraph>
          Dead-lettered webhook events: {deadWebhookEvents}. A non-zero value
          requires operator requeue and investigation.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
