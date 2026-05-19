import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig([
  {
    input: "./openapi-schemas/platform.yaml",
    output: "src/generated/api",
    plugins: ["@hey-api/client-fetch", "@tanstack/react-query"],
  },
  {
    input: "./openapi-schemas/auth.yaml",
    output: "src/generated/auth",
    plugins: ["@hey-api/client-fetch"],
  },
]);
