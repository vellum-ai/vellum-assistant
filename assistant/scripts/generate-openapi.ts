#!/usr/bin/env bun
/**
 * Generate a minimal OpenAPI 3.0 YAML specification from the assistant's
 * HTTP route definitions.
 *
 * Pipeline:
 *   1. Programmatically import and invoke all *RouteDefinitions() exports
 *      from src/runtime/routes/ — no regex, no source-text parsing.
 *   2. Combine with inline routes (defined in buildRouteTable()) and
 *      pre-auth / non-v1 routes.
 *   3. Convert to OpenAPI path items.
 *   4. Write to openapi.yaml.
 *
 * Usage:
 *   cd assistant && bun run scripts/generate-openapi.ts
 *   cd assistant && bun run generate:openapi            # via npm script
 *   cd assistant && bun run generate:openapi -- --check  # CI: fail if stale
 */

import { readFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { stringify } from "yaml";
import { z } from "zod";

const ROOT = resolve(import.meta.dir, "..");
const ROUTES_DIR = join(ROOT, "src/runtime/routes");
const OUTPUT_PATH = join(ROOT, "openapi.yaml");
const PKG_PATH = join(ROOT, "package.json");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RouteQueryParamSchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  required: z.boolean().optional(),
  description: z.string().optional(),
});

const RouteBodySchemaSchema = z.object({
  type: z.string(),
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
  description: z.string().optional(),
});

const RouteEntrySchema = z.object({
  method: z.string(),
  /** Endpoint path relative to /v1/ (e.g. "conversations/:id"). */
  endpoint: z.string(),
  /** Short summary for OpenAPI operation. */
  summary: z.string().optional(),
  /** Longer description for OpenAPI operation. */
  description: z.string().optional(),
  /** Grouping tags. */
  tags: z.array(z.string()).optional(),
  /** Query parameter definitions. */
  queryParams: z.array(RouteQueryParamSchema).optional(),
  /** JSON Schema for the request body. */
  requestBody: RouteBodySchemaSchema.optional(),
  /** JSON Schema for the 200 response body. */
  responseBody: RouteBodySchemaSchema.optional(),
  /** Source module filename, used for auto-deriving tags. */
  sourceModule: z.string().optional(),
});

type RouteBodySchema = z.infer<typeof RouteBodySchemaSchema>;
type RouteEntry = z.infer<typeof RouteEntrySchema>;

// ---------------------------------------------------------------------------
// Programmatic route extraction
// ---------------------------------------------------------------------------

/**
 * Create a recursive proxy that stands in for any dependency object.
 *
 * Route definition functions capture deps in handler closures but never
 * access them during array construction, so this stub is never actually
 * invoked at runtime — it just needs to be truthy and not throw when
 * properties are read or the value is called as a function.
 */
function createDeepStub(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub: any = new Proxy(function () {}, {
    get(_target, prop) {
      // Prevent the stub from being treated as a Promise (await-able).
      if (prop === "then") return undefined;
      // Prevent infinite iteration.
      if (prop === Symbol.iterator) return undefined;
      // String coercion.
      if (prop === Symbol.toPrimitive) return () => "";
      return createDeepStub();
    },
    apply() {
      return createDeepStub();
    },
  });
  return stub;
}

/**
 * Dynamically import every route module under `src/runtime/routes/`,
 * find all exported functions whose names end with `RouteDefinitions`,
 * invoke each with a deep stub as its first argument, and collect the
 * `{ endpoint, method }` pairs from the returned arrays.
 *
 * This replaces the previous regex + balanced-brace scanning approach
 * and automatically picks up new route modules without manual updates.
 */
async function collectRoutesFromModules(): Promise<RouteEntry[]> {
  const routes: RouteEntry[] = [];

  const files = (await readdir(ROUTES_DIR, { recursive: true })).filter(
    (f) =>
      typeof f === "string" &&
      f.endsWith(".ts") &&
      !f.endsWith(".test.ts") &&
      !f.endsWith(".benchmark.test.ts") &&
      !f.includes("node_modules"),
  );

  for (const file of files) {
    const filePath = join(ROUTES_DIR, file);
    let mod: Record<string, unknown>;
    try {
      mod = (await import(filePath)) as Record<string, unknown>;
    } catch (err) {
      console.warn(
        `Warning: could not import ${file}: ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }

    for (const [exportName, exportValue] of Object.entries(mod)) {
      if (
        !exportName.endsWith("RouteDefinitions") ||
        typeof exportValue !== "function"
      ) {
        continue;
      }

      try {
        const rawDefs = exportValue(createDeepStub());
        if (!Array.isArray(rawDefs)) continue;
        for (const raw of rawDefs) {
          const result = RouteEntrySchema.safeParse({
            ...(typeof raw === "object" && raw !== null ? raw : {}),
            sourceModule: file,
          });
          if (result.success) {
            routes.push(result.data);
          }
        }
      } catch (err) {
        console.warn(
          `Warning: ${exportName}() in ${file} threw: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  return routes;
}

/**
 * Routes defined inline in RuntimeHttpServer.buildRouteTable() that are
 * not exported from any route module. These are kept here because they
 * depend on cross-cutting concerns specific to the RuntimeHttpServer
 * instance (see B2 in the improvement plan for the recommendation to
 * extract these into modules).
 *
 * Whenever buildRouteTable() gains or loses an inline route, this list
 * must be updated manually. Note: `--check` only compares the generated
 * YAML against the committed YAML, so it will NOT catch a missing entry
 * here if openapi.yaml is also stale. Plan items B2/C2 address this gap.
 */
const INLINE_ROUTES: RouteEntry[] = [
  { endpoint: "browser-relay/status", method: "GET" },
  { endpoint: "browser-relay/command", method: "POST" },
  { endpoint: "conversations", method: "GET" },
  { endpoint: "conversations/seen", method: "POST" },
  { endpoint: "conversations/unread", method: "POST" },
  { endpoint: "conversations/:id", method: "GET" },
  { endpoint: "interfaces/:path*", method: "GET" },
  { endpoint: "internal/twilio/voice-webhook", method: "POST" },
  { endpoint: "internal/twilio/status", method: "POST" },
  { endpoint: "internal/twilio/connect-action", method: "POST" },
  { endpoint: "internal/oauth/callback", method: "POST" },
];

/**
 * Pre-auth routes handled directly in routeRequest() before the router.
 * These are a small, stable set that bypass JWT authentication and are
 * not part of the declarative route table.
 */
const PRE_AUTH_ROUTES: RouteEntry[] = [
  { method: "GET", endpoint: "audio/:id" },
  { method: "POST", endpoint: "guardian/init" },
  { method: "POST", endpoint: "guardian/refresh" },
  { method: "POST", endpoint: "pairing/request" },
  { method: "GET", endpoint: "pairing/status" },
];

/**
 * Top-level routes outside the /v1/ namespace.
 * These are added to the spec separately.
 */
const NON_V1_ROUTES: Array<{ method: string; path: string }> = [
  { method: "GET", path: "/healthz" },
  { method: "GET", path: "/readyz" },
  { method: "GET", path: "/pages/{id}" },
];

// ---------------------------------------------------------------------------
// OpenAPI helpers
// ---------------------------------------------------------------------------

/** Convert route endpoint `:param` / `:param*` syntax to OpenAPI `{param}`. */
function toOpenApiPath(endpoint: string): string {
  return (
    "/v1/" + endpoint.replace(/:(\w+)\*/g, "{$1}").replace(/:(\w+)/g, "{$1}")
  );
}

/** Derive a unique operationId from the endpoint and HTTP method. */
function toOperationId(endpoint: string, method: string): string {
  const slug = endpoint
    .replace(/:(\w+)\*/g, "by_$1")
    .replace(/:(\w+)/g, "by_$1")
    .replace(/[/]/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "");
  return `${slug}_${method.toLowerCase()}`;
}

/** Extract path parameter names from an OpenAPI-style path. */
function extractPathParams(openApiPath: string): string[] {
  const params: string[] = [];
  const re = /\{(\w+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(openApiPath)) !== null) {
    params.push(m[1]);
  }
  return params;
}

// ---------------------------------------------------------------------------
// Spec builder
// ---------------------------------------------------------------------------

interface OpenApiParameter {
  name: string;
  in: string;
  required: boolean;
  schema: { type: string };
  description?: string;
}

interface OpenApiOperation {
  operationId: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    required: boolean;
    content: {
      "application/json": {
        schema: RouteBodySchema;
      };
    };
  };
  responses: Record<
    string,
    {
      description: string;
      content?: {
        "application/json": {
          schema: RouteBodySchema;
        };
      };
    }
  >;
}

interface OpenApiPathItem {
  [method: string]: OpenApiOperation;
}

/** Derive a tag name from a route module filename (e.g. "secret-routes.ts" → "secrets"). */
function deriveTagFromModule(filename: string): string {
  // Strip directory prefix and extension
  const base = filename.replace(/^.*[\/]/, "").replace(/\.ts$/, "");
  // Remove trailing "-routes" suffix
  return base.replace(/-routes$/, "");
}

function buildSpec(
  routes: RouteEntry[],
  version: string,
): Record<string, unknown> {
  // Deduplicate by path+method
  const seen = new Set<string>();
  const uniqueRoutes: Array<{
    path: string;
    method: string;
    endpoint: string;
    entry: RouteEntry;
  }> = [];

  // Non-v1 routes first
  for (const r of NON_V1_ROUTES) {
    const key = `${r.method}:${r.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueRoutes.push({
        path: r.path,
        method: r.method,
        endpoint: r.path,
        entry: { method: r.method, endpoint: r.path },
      });
    }
  }

  // v1 routes
  for (const r of routes) {
    const openApiPath = toOpenApiPath(r.endpoint);
    const key = `${r.method}:${openApiPath}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueRoutes.push({
        path: openApiPath,
        method: r.method,
        endpoint: r.endpoint,
        entry: r,
      });
    }
  }

  // Sort by path, then by method for deterministic output
  uniqueRoutes.sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    return a.method.localeCompare(b.method);
  });

  // Build paths object
  const paths: Record<string, OpenApiPathItem> = {};
  for (const route of uniqueRoutes) {
    if (!paths[route.path]) {
      paths[route.path] = {};
    }

    const methodLower = route.method.toLowerCase();
    const operationId = route.path.startsWith("/v1/")
      ? toOperationId(route.endpoint, route.method)
      : route.path.replace(/^\//, "").replace(/[/{}\-]/g, "_") +
        `_${methodLower}`;

    const { entry } = route;

    // Build parameters: path params + query params from metadata
    const pathParams = extractPathParams(route.path);
    const parameters: OpenApiParameter[] = pathParams.map((name) => ({
      name,
      in: "path" as const,
      required: true,
      schema: { type: "string" },
    }));

    if (entry.queryParams) {
      for (const qp of entry.queryParams) {
        parameters.push({
          name: qp.name,
          in: "query",
          required: qp.required ?? false,
          schema: { type: qp.type ?? "string" },
          ...(qp.description ? { description: qp.description } : {}),
        });
      }
    }

    // Determine tags: explicit tags > auto-derived from source module
    const tags: string[] | undefined =
      entry.tags && entry.tags.length > 0
        ? entry.tags
        : entry.sourceModule
          ? [deriveTagFromModule(entry.sourceModule)]
          : undefined;

    // Build the operation
    const operation: OpenApiOperation = {
      operationId,
      ...(entry.summary ? { summary: entry.summary } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      ...(tags ? { tags } : {}),
      responses: {
        "200": entry.responseBody
          ? {
              description: "Successful response",
              content: {
                "application/json": { schema: entry.responseBody },
              },
            }
          : { description: "Successful response" },
      },
    };

    if (parameters.length > 0) {
      operation.parameters = parameters;
    }

    if (entry.requestBody) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": { schema: entry.requestBody },
        },
      };
    }

    paths[route.path][methodLower] = operation;
  }

  return {
    openapi: "3.0.0",
    info: {
      title: "Vellum Assistant API",
      version,
      description:
        "Auto-generated OpenAPI specification for the Vellum Assistant runtime HTTP server.",
    },
    servers: [
      {
        url: "http://127.0.0.1:7821",
        description: "Local assistant (default port)",
      },
    ],
    paths,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const isCheck = process.argv.includes("--check");

  // Read package version
  const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8")) as {
    version: string;
  };
  const version = pkg.version;

  // Collect routes programmatically from route modules
  const moduleRoutes = await collectRoutesFromModules();

  // Combine all route sources
  const allRoutes: RouteEntry[] = [
    ...PRE_AUTH_ROUTES,
    ...INLINE_ROUTES,
    ...moduleRoutes,
  ];

  // Build the spec
  const spec = buildSpec(allRoutes, version);
  const yamlOutput =
    "# Auto-generated by scripts/generate-openapi.ts — DO NOT EDIT\n" +
    "# Regenerate: cd assistant && bun run generate:openapi\n" +
    stringify(spec, { lineWidth: 120 });

  if (isCheck) {
    let existing: string;
    try {
      existing = await readFile(OUTPUT_PATH, "utf-8");
    } catch {
      console.error(
        "openapi.yaml does not exist. Run: bun run generate:openapi",
      );
      process.exit(1);
    }
    if (existing !== yamlOutput) {
      console.error("openapi.yaml is stale. Run: bun run generate:openapi");
      process.exit(1);
    }
    console.log("openapi.yaml is up to date.");
    return;
  }

  await writeFile(OUTPUT_PATH, yamlOutput);

  // Count stats
  const pathCount = Object.keys(spec.paths as Record<string, unknown>).length;
  const operationCount = Object.values(
    spec.paths as Record<string, Record<string, unknown>>,
  ).reduce((n, methods) => n + Object.keys(methods).length, 0);

  console.log(`Generated ${OUTPUT_PATH}`);
  console.log(`  ${pathCount} paths, ${operationCount} operations`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
