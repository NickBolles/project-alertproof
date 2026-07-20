import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { Outlet, useLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticateAdmin } from "../lib/auth.server";
import { env } from "../lib/env.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticateAdmin(request);
  return { apiKey: env.SHOPIFY_API_KEY };
}

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  return (
    <AppProvider embedded apiKey={apiKey}>
      <nav aria-label="AlertProof">
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/rules">Rules</s-link>
        <s-link href="/app/recipients">Recipients</s-link>
        <s-link href="/app/log">Delivery log</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/billing">Plans</s-link>
      </nav>
      <Outlet />
    </AppProvider>
  );
}
