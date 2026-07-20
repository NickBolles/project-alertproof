import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import prisma from "../db.server";
import { authenticateAdmin } from "../lib/auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticateAdmin(request);
  return {
    rules: await prisma.rule.findMany({
      where: { shop: { shopDomain: session.shop } },
      include: { recipients: true },
      orderBy: { createdAt: "desc" },
    }),
  };
}

export default function RulesPage() {
  const { rules } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Alert rules">
      <Link to="/app/rules/new">Create rule</Link>
      <s-section heading="Rules">
        {rules.length === 0 ? (
          <s-paragraph>No rules yet.</s-paragraph>
        ) : (
          rules.map((rule) => (
            <div key={rule.id}>
              <s-heading>{rule.name}</s-heading>
              <s-paragraph>
                {rule.trigger} · {rule.enabled ? "Enabled" : "Disabled"} ·{" "}
                {rule.recipients.length} recipients
              </s-paragraph>
              <Link to={`/app/rules/${rule.id}`}>Edit</Link>
            </div>
          ))
        )}
      </s-section>
    </s-page>
  );
}
