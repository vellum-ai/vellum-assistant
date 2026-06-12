import { defineConfig } from "@hey-api/openapi-ts";

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
]);
