/**
 * Transforms the gateway's OpenAPI spec for web app codegen.
 *
 * The gateway serves endpoints at `/v1/{path}`, but the web app calls them
 * through the platform gateway at `/v1/assistants/{assistant_id}/{path}`.
 * This script rewrites gateway spec paths to match the proxied URLs
 * and adds `assistant_id` as a required path parameter to every operation.
 *
 * Output is JSON since openapi-ts accepts both formats and JSON avoids
 * needing a YAML serializer dependency.
 *
 * Usage: bun run scripts/transform-gateway-spec.ts
 * Output: openapi-schemas/gateway.json (gitignored, consumed by openapi-ts)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const WEB_ROOT = resolve(SCRIPT_DIR, "..");
const GATEWAY_SPEC_PATH = resolve(WEB_ROOT, "../../gateway/openapi.json");
const OUTPUT_PATH = resolve(WEB_ROOT, "openapi-schemas/gateway.json");

const ASSISTANT_ID_PARAM = {
  name: "assistant_id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "The assistant ID (injected by the platform gateway)",
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const raw = readFileSync(GATEWAY_SPEC_PATH, "utf-8");
const spec = JSON.parse(raw) as Record<string, unknown>;

// Override server URL — the web app calls the same-origin gateway.
spec.servers = [{ url: "", description: "Same-origin (platform gateway)" }];

const sourcePaths = (spec.paths ?? {}) as Record<
  string,
  Record<string, unknown>
>;
const transformedPaths: Record<string, unknown> = {};
let included = 0;

for (const [path, methods] of Object.entries(sourcePaths)) {
  if (!path.startsWith("/v1/")) {
    continue;
  }

  // /v1/{rest} → /v1/assistants/{assistant_id}/{rest}
  const rest = path.slice("/v1/".length);
  const newPath = `/v1/assistants/{assistant_id}/${rest}`;

  for (const [key, value] of Object.entries(methods)) {
    if (key === "parameters") continue;
    const operation = value as Record<string, unknown>;
    const params = (operation.parameters ?? []) as Array<
      Record<string, unknown>
    >;
    if (!params.some((p) => p.name === "assistant_id")) {
      operation.parameters = [ASSISTANT_ID_PARAM, ...params];
    }

    // Prefix operationId with "assistant" to disambiguate from
    // non-assistant-scoped gateway endpoints and produce descriptive
    // generated function names (e.g., assistantFeatureFlagsGet).
    if (operation.operationId && typeof operation.operationId === "string") {
      operation.operationId = `assistant${operation.operationId.charAt(0).toUpperCase()}${operation.operationId.slice(1)}`;
    }
  }

  transformedPaths[newPath] = methods;
  included++;
}

spec.paths = transformedPaths;

const info = spec.info as Record<string, unknown>;
info.title = "Vellum Gateway API (assistant-scoped paths)";
info.description =
  "Gateway spec with assistant-prefixed paths for web app codegen. " +
  "Auto-generated — do not edit. Regenerate: cd apps/web && bun run scripts/transform-gateway-spec.ts";

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, JSON.stringify(spec, null, 2) + "\n");

console.log(`Wrote ${OUTPUT_PATH} (${included} paths included)`);
