import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  // Codegen is not functional yet. Once the platform publishes the OpenAPI spec
  // at a public URL, this config will point there and generate API clients
  // automatically via a postinstall hook. See LUM-1573.
  input: "./openapi-schemas/schema_v1.yaml",
  output: "src/generated/heyapi",
  plugins: [
    "@hey-api/client-fetch",
    "@tanstack/react-query",
  ],
});
