import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig([
  {
    input: "./openapi-schemas/platform.yaml",
    output: "src/generated/api",
    plugins: [
      "@hey-api/client-fetch",
      { name: "@tanstack/react-query", useMutation: true },
    ],
  },
  {
    input: "./openapi-schemas/auth.yaml",
    output: "src/generated/auth",
    plugins: ["@hey-api/client-fetch"],
  },
  {
    input: "./openapi-schemas/daemon.json",
    output: "src/generated/daemon",
    plugins: [
      "@hey-api/client-fetch",
      { name: "@tanstack/react-query", useMutation: true },
    ],
  },
]);
