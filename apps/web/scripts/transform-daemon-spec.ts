/**
 * Transforms the daemon's OpenAPI spec for web app codegen.
 *
 * The daemon serves endpoints at `/v1/{path}`, but the web app calls them
 * through the platform gateway at `/v1/assistants/{assistant_id}/{path}`.
 * This script rewrites daemon spec paths to match the gateway-proxied URLs
 * and adds `assistant_id` as a required path parameter to every operation.
 *
 * Output is JSON (not YAML) since openapi-ts accepts both formats and
 * JSON avoids needing a YAML serializer dependency.
 *
 * Usage: bun run scripts/transform-daemon-spec.ts
 * Output: openapi-schemas/daemon.json (gitignored, consumed by openapi-ts)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import YAML from "js-yaml";

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const WEB_ROOT = resolve(SCRIPT_DIR, "..");
const DAEMON_SPEC_PATH = resolve(WEB_ROOT, "../../assistant/openapi.yaml");
const OUTPUT_PATH = resolve(WEB_ROOT, "openapi-schemas/daemon.json");

/**
 * Paths to exclude from the web-facing SDK. These are internal, CLI-only,
 * admin, or debug endpoints not proxied through the platform gateway.
 */
const EXCLUDED_PREFIXES = [
  "/healthz",
  "/readyz",
  "/pages/",
  "/v1/admin/",
  "/v1/acp/",
  "/v1/btw",
  "/v1/clients",
  "/v1/conversations/cli/",
  "/v1/debug",
  "/v1/diagnostics/",
  "/v1/host-",
  "/v1/internal/",
  "/v1/migration",
  "/v1/profiler/",
  "/v1/sanity/",
];

const EXCLUDED_SEGMENTS = ["/playground/"];

/**
 * Web-facing exceptions that fall under an excluded prefix but ARE proxied
 * through the platform gateway and consumed by the web app. Most `/v1/acp/`
 * routes are CLI-only session endpoints, but credential-linking is a settings
 * UI flow and must be present in the generated SDK.
 */
const INCLUDED_PATHS = ["/v1/acp/credentials/link"];

function shouldExclude(path: string): boolean {
  if (INCLUDED_PATHS.includes(path)) return false;
  if (EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (EXCLUDED_SEGMENTS.some((seg) => path.includes(seg))) return true;
  return false;
}

const ASSISTANT_ID_PARAM = {
  name: "assistant_id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "The assistant ID (injected by the platform gateway)",
};

/**
 * The daemon's Zod-to-JSON-Schema conversion can produce inline `$defs`
 * for recursive schemas (e.g. process trees). OpenAPI 3.0 tooling expects
 * `$ref` to resolve against `#/components/schemas/`, not inline `$defs`.
 *
 * This function walks the spec tree, hoists any inline `$defs` to
 * `components.schemas`, and rewrites `$ref` pointers accordingly.
 */
function hoistInlineDefs(
  node: unknown,
  componentSchemas: Record<string, unknown>,
  counter: { value: number },
): unknown {
  if (node === null || node === undefined || typeof node !== "object") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((item) =>
      hoistInlineDefs(item, componentSchemas, counter),
    );
  }

  const obj = node as Record<string, unknown>;

  // If this schema object has local $defs, hoist them.
  if (obj.$defs && typeof obj.$defs === "object") {
    const localDefs = obj.$defs as Record<string, unknown>;
    const renameMap: Record<string, string> = {};

    for (const [defName] of Object.entries(localDefs)) {
      renameMap[defName] = `_daemon_${counter.value++}_${defName}`;
    }

    // Hoist each definition with its refs already rewritten.
    for (const [defName, defSchema] of Object.entries(localDefs)) {
      const hoisted = hoistInlineDefs(defSchema, componentSchemas, counter);
      componentSchemas[renameMap[defName]] = rewriteRefs(
        hoisted,
        renameMap,
        componentSchemas,
        counter,
      );
    }

    delete obj.$defs;

    // Rewrite $ref pointers within the parent subtree, then recurse
    // to catch any nested $defs in sibling properties.
    const rewritten = rewriteRefs(obj, renameMap, componentSchemas, counter);
    return hoistInlineDefs(rewritten, componentSchemas, counter);
  }

  // Recurse into all properties.
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = hoistInlineDefs(value, componentSchemas, counter);
  }
  return result;
}

function rewriteRefs(
  node: unknown,
  renameMap: Record<string, string>,
  componentSchemas: Record<string, unknown>,
  counter: { value: number },
): unknown {
  if (node === null || node === undefined || typeof node !== "object") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((item) =>
      rewriteRefs(item, renameMap, componentSchemas, counter),
    );
  }

  const obj = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (key === "$ref" && typeof value === "string") {
      const match = value.match(/^#\/\$defs\/(.+)$/);
      if (match && renameMap[match[1]]) {
        result.$ref = `#/components/schemas/${renameMap[match[1]]}`;
        continue;
      }
    }
    result[key] = rewriteRefs(value, renameMap, componentSchemas, counter);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const raw = readFileSync(DAEMON_SPEC_PATH, "utf-8");
const spec = YAML.load(raw) as Record<string, unknown>;

// Override server URL — the web app calls the same-origin gateway, not
// the daemon directly.
spec.servers = [{ url: "", description: "Same-origin (platform gateway)" }];

// Ensure components.schemas exists for hoisted definitions.
if (!spec.components) spec.components = {};
const components = spec.components as Record<string, unknown>;
if (!components.schemas) components.schemas = {};
const componentSchemas = components.schemas as Record<string, unknown>;

const sourcePaths = (spec.paths ?? {}) as Record<
  string,
  Record<string, unknown>
>;
const transformedPaths: Record<string, unknown> = {};
let included = 0;
let excluded = 0;

for (const [path, methods] of Object.entries(sourcePaths)) {
  if (shouldExclude(path)) {
    excluded++;
    continue;
  }

  if (!path.startsWith("/v1/")) {
    excluded++;
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
  }

  transformedPaths[newPath] = methods;
  included++;
}

spec.paths = transformedPaths;

// Hoist inline $defs → components.schemas so $ref pointers resolve.
const counter = { value: 0 };
spec.paths = hoistInlineDefs(spec.paths, componentSchemas, counter);

const info = spec.info as Record<string, unknown>;
info.title = "Vellum Assistant Daemon API (gateway paths)";
info.description =
  "Daemon spec with gateway-prefixed paths for web app codegen. " +
  "Auto-generated — do not edit. Regenerate: cd apps/web && bun run scripts/transform-daemon-spec.ts";

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, JSON.stringify(spec, null, 2) + "\n");

console.log(
  `Wrote ${OUTPUT_PATH} (${included} paths included, ${excluded} excluded)`,
);
if (counter.value > 0) {
  console.log(
    `Hoisted ${counter.value} inline $defs to components.schemas`,
  );
}
