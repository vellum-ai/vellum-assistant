#!/usr/bin/env bun
/**
 * Generate a minimal OpenAPI 3.0 YAML specification from the assistant's
 * HTTP route definitions.
 *
 * Pipeline:
 *   1. Read all route definition files (src/runtime/routes/*.ts)
 *   2. Read http-server.ts for inline and pre-auth routes
 *   3. Extract endpoint + method pairs via static analysis
 *   4. Convert to OpenAPI path items
 *   5. Write to openapi.yaml
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

const ROOT = resolve(import.meta.dir, "..");
const ROUTES_DIR = join(ROOT, "src/runtime/routes");
const HTTP_SERVER_PATH = join(ROOT, "src/runtime/http-server.ts");
const OUTPUT_PATH = join(ROOT, "openapi.yaml");
const PKG_PATH = join(ROOT, "package.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RouteQueryParam {
  name: string;
  required?: boolean;
  description?: string;
  schema?: { type: string };
}

interface RouteEntry {
  method: string;
  /** Endpoint path relative to /v1/ (e.g. "conversations/:id"). */
  endpoint: string;
  /** Short one-line summary for the OpenAPI operation. */
  summary?: string;
  /** Longer description (Markdown allowed). */
  description?: string;
  /** Tags used to group operations in the generated spec. */
  tags?: string[];
  /** Query parameters accepted by this endpoint. */
  queryParams?: RouteQueryParam[];
}

// ---------------------------------------------------------------------------
// Route extraction
// ---------------------------------------------------------------------------

/**
 * Extract endpoint/method pairs from a TypeScript source string.
 *
 * Matches route definition objects of the form:
 *   { endpoint: "...", method: "...", handler: ... }
 * where endpoint and method can appear in either order within the object.
 *
 * To avoid picking up a `method:` from a neighboring route object, we find
 * the enclosing `{ ... }` block for each `endpoint` match by scanning for
 * balanced braces.
 */
function extractRouteDefinitions(source: string): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const endpointRe = /endpoint:\s*["'`]([^"'`]+)["'`]/g;

  let match: RegExpExecArray | null;
  while ((match = endpointRe.exec(source)) !== null) {
    const endpoint = match[1];
    const pos = match.index;

    // Walk backwards from the endpoint match to find the opening `{` of the
    // enclosing object literal, respecting nesting depth.
    let depth = 0;
    let blockStart = -1;
    for (let i = pos - 1; i >= 0; i--) {
      if (source[i] === "}") depth++;
      if (source[i] === "{") {
        if (depth === 0) {
          blockStart = i;
          break;
        }
        depth--;
      }
    }

    // Walk forwards to find the matching closing `}`.
    depth = 0;
    let blockEnd = -1;
    const searchStart = blockStart >= 0 ? blockStart : pos;
    for (let i = searchStart; i < source.length; i++) {
      if (source[i] === "{") depth++;
      if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          blockEnd = i + 1;
          break;
        }
      }
    }

    if (blockStart < 0 || blockEnd < 0) continue;

    const block = source.slice(blockStart, blockEnd);
    const methodMatch = block.match(/method:\s*["'`]([A-Z]+)["'`]/);
    if (methodMatch) {
      const entry: RouteEntry = { method: methodMatch[1], endpoint };

      // Extract queryParams first so we can strip them from the block before
      // matching top-level scalar fields like description (which also appears
      // inside individual queryParam objects).
      const queryParamsMatch = block.match(
        /queryParams:\s*\[((?:[^\[\]]|\[[^\]]*\])*)\]/,
      );
      if (queryParamsMatch) {
        entry.queryParams = extractQueryParams(queryParamsMatch[1]);
      }

      // Strip the queryParams block so nested `description:` values don't
      // collide with the top-level route description regex below.
      const scalarBlock = queryParamsMatch
        ? block.replace(queryParamsMatch[0], "")
        : block;

      const summaryMatch = scalarBlock.match(/summary:\s*["'`]([^"'`]+)["'`]/);
      if (summaryMatch) entry.summary = summaryMatch[1];

      const descriptionMatch = scalarBlock.match(
        /description:\s*["'`]([^"'`]+)["'`]/,
      );
      if (descriptionMatch) entry.description = descriptionMatch[1];

      const tagsMatch = scalarBlock.match(/tags:\s*\[([^\]]+)\]/);
      if (tagsMatch) {
        entry.tags = tagsMatch[1]
          .split(",")
          .map((t) => t.trim().replace(/^["'`]|["'`]$/g, ""))
          .filter(Boolean);
      }

      routes.push(entry);
    }
  }

  return routes;
}

/**
 * Parse queryParams array content extracted via regex into structured objects.
 */
function extractQueryParams(raw: string): RouteQueryParam[] {
  const params: RouteQueryParam[] = [];
  // Match individual `{ name: "...", ... }` objects within the array.
  const objRe = /\{([^}]+)\}/g;
  let objMatch: RegExpExecArray | null;
  while ((objMatch = objRe.exec(raw)) !== null) {
    const inner = objMatch[1];
    const nameMatch = inner.match(/name:\s*["'`]([^"'`]+)["'`]/);
    if (!nameMatch) continue;
    const param: RouteQueryParam = { name: nameMatch[1] };

    const reqMatch = inner.match(/required:\s*(true|false)/);
    if (reqMatch) param.required = reqMatch[1] === "true";

    const descMatch = inner.match(/description:\s*["'`]([^"'`]+)["'`]/);
    if (descMatch) param.description = descMatch[1];

    const typeMatch = inner.match(/type:\s*["'`]([^"'`]+)["'`]/);
    if (typeMatch) param.schema = { type: typeMatch[1] };

    params.push(param);
  }
  return params;
}

/**
 * Pre-auth routes handled directly in routeRequest() before the router.
 * These are a small, stable set that bypass JWT authentication.
 */
const PRE_AUTH_ROUTES: RouteEntry[] = [
  // Handled outside /v1/ namespace
  // { method: "GET", endpoint: "__healthz" },   // /healthz — non-v1
  // { method: "GET", endpoint: "__readyz" },     // /readyz  — non-v1

  // These are matched in routeRequest() before auth, but are also in the
  // route table for authenticated access. We include the pre-auth-only ones:
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
  responses: Record<string, { description: string }>;
  parameters?: OpenApiParameter[];
}

interface OpenApiPathItem {
  [method: string]: OpenApiOperation;
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
    summary?: string;
    description?: string;
    tags?: string[];
    queryParams?: RouteQueryParam[];
  }> = [];

  // Non-v1 routes first
  for (const r of NON_V1_ROUTES) {
    const key = `${r.method}:${r.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueRoutes.push({ path: r.path, method: r.method, endpoint: r.path });
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
        summary: r.summary,
        description: r.description,
        tags: r.tags,
        queryParams: r.queryParams,
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

    const pathParams = extractPathParams(route.path);
    const operation: OpenApiOperation = {
      operationId,
      responses: {
        "200": { description: "Successful response" },
      },
    };

    // Attach OpenAPI metadata from route definitions when present.
    if (route.summary) operation.summary = route.summary;
    if (route.description) operation.description = route.description;
    if (route.tags && route.tags.length > 0) operation.tags = route.tags;

    // Path parameters
    const parameters: OpenApiParameter[] = pathParams.map((name) => ({
      name,
      in: "path" as const,
      required: true,
      schema: { type: "string" },
    }));

    // Query parameters from route metadata
    if (route.queryParams) {
      for (const qp of route.queryParams) {
        parameters.push({
          name: qp.name,
          in: "query",
          required: qp.required ?? false,
          schema: qp.schema ?? { type: "string" },
          ...(qp.description ? { description: qp.description } : {}),
        });
      }
    }

    if (parameters.length > 0) {
      operation.parameters = parameters;
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

  // Collect routes from all route definition files
  const allRoutes: RouteEntry[] = [...PRE_AUTH_ROUTES];

  // 1. Read route definition files in src/runtime/routes/
  const routeFiles = (await readdir(ROUTES_DIR, { recursive: true })).filter(
    (f) =>
      typeof f === "string" &&
      f.endsWith(".ts") &&
      !f.endsWith(".test.ts") &&
      !f.includes("node_modules"),
  );

  for (const file of routeFiles) {
    const filePath = join(ROUTES_DIR, file);
    const source = await readFile(filePath, "utf-8");
    const routes = extractRouteDefinitions(source);
    allRoutes.push(...routes);
  }

  // 2. Read http-server.ts for inline route definitions in buildRouteTable()
  const httpServerSource = await readFile(HTTP_SERVER_PATH, "utf-8");
  const inlineRoutes = extractRouteDefinitions(httpServerSource);
  allRoutes.push(...inlineRoutes);

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
