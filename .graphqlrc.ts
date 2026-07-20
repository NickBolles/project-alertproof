import fs from "node:fs";
import { ApiVersion } from "@shopify/shopify-app-react-router/server";
import { ApiType, shopifyApiProject } from "@shopify/api-codegen-preset";
import type { IGraphQLConfig } from "graphql-config";

function getConfig(): IGraphQLConfig {
  const config: IGraphQLConfig = {
    projects: {
      default: shopifyApiProject({
        apiType: ApiType.Admin,
        apiVersion: ApiVersion.July26,
        documents: ["./app/**/*.{js,ts,jsx,tsx}"],
        outputDir: "./app/types",
      }),
    },
  };

  for (const entry of fs.existsSync("./extensions")
    ? fs.readdirSync("./extensions")
    : []) {
    const extensionPath = `./extensions/${entry}`;
    const schema = `${extensionPath}/schema.graphql`;
    if (fs.existsSync(schema)) {
      config.projects![entry] = {
        schema,
        documents: [`${extensionPath}/**/*.graphql`],
      };
    }
  }

  return config;
}

export default getConfig();
