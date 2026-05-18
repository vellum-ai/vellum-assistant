/**
 * Type stubs for the HeyAPI-generated API client.
 *
 * The generated output (`src/generated/api/`) is gitignored because the
 * OpenAPI spec cannot be committed to this open-source repo. These
 * declarations let TypeScript resolve the module even when codegen has
 * not been run locally.
 *
 * After running `bun run openapi-ts`, the real generated files take
 * precedence over this declaration (TypeScript resolves .ts/.js files
 * before .d.ts ambient modules).
 */

declare module "@/generated/api/client.gen.js" {
  interface ClientConfig {
    baseUrl?: string;
    [key: string]: unknown;
  }

  interface Client {
    setConfig(config: ClientConfig): void;
  }

  export const client: Client;
}
