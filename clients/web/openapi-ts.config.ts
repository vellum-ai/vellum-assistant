import { defaultPaginationKeywords, defineConfig } from "@hey-api/openapi-ts";

const reactQueryPlugin = {
  name: "@tanstack/react-query",
  useMutation: true,
  useQuery: false,
  setQueryData: true,
};

export default defineConfig([
  {
    input: "./openapi-schemas/platform.yaml",
    output: "src/generated/api",
    parser: {
      // HeyAPI only detects pagination params by exact keyword match, so the
      // invoices endpoint's starting_after cursor needs an explicit entry to
      // get the generated infinite query key/options.
      pagination: {
        keywords: [...defaultPaginationKeywords, "starting_after"],
      },
    },
    plugins: ["@hey-api/client-fetch", reactQueryPlugin],
  },
  {
    input: "./openapi-schemas/auth.yaml",
    output: "src/generated/auth",
    plugins: ["@hey-api/client-fetch"],
  },
  {
    input: "./openapi-schemas/daemon.json",
    output: "src/generated/daemon",
    plugins: ["@hey-api/client-fetch", reactQueryPlugin],
  },
  {
    input: "./openapi-schemas/gateway.json",
    output: "src/generated/gateway",
    plugins: ["@hey-api/client-fetch", reactQueryPlugin],
  },
]);
