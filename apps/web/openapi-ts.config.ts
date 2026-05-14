import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "./openapi-schemas/schema_v1.yaml",
  output: "src/generated/heyapi",
  plugins: [
    "@hey-api/client-fetch",
    "@tanstack/react-query",
  ],
});
