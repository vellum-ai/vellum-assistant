/**
 * Configured HeyAPI client for daemon API requests.
 *
 * All hand-written API wrappers (home feed, avatar, etc.) import this
 * singleton instead of depending on generated code. The generated
 * client (from codegen) uses its own inline-bundled instance; this one
 * is for endpoints that aren't in the OpenAPI spec.
 *
 * Reference: https://heyapi.dev/openapi-ts/clients/fetch
 */
import { createClient } from "@/generated/api/client/index.js";

export const client = createClient({
  baseUrl: "",
});
