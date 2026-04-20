import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSchema } from "../schema.js";

/** A route extracted from source: path + optional HTTP method. */
interface ExtractedRoute {
  path: string;
  method: string | null; // null means "any method"
}

/**
 * Extracts route paths from the gateway index.ts source code.
 *
 * Routes are defined in two places:
 * 1. The `routes` array (RouteDefinition[]) — matched by the router
 * 2. Pre-router paths in the `fetch()` handler (healthz, readyz, schema, WS upgrades)
 *
 * We parse the source text rather than importing index.ts because it calls
 * `main()` at module scope which starts the server.
 */
function extractRoutesFromSource(): ExtractedRoute[] {
  const src = readFileSync(
    join(import.meta.dirname!, "..", "index.ts"),
    "utf-8",
  );

  const lines = src.split("\n");
  const routes: ExtractedRoute[] = [];
  const seenPreRouterPaths = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match string literal paths: `path: "/some/path"`
    const stringMatch = line.match(/path:\s*"([^"]+)"/);
    if (stringMatch) {
      const method = findMethodNearPath(lines, i);
      routes.push({ path: stringMatch[1], method });
      continue;
    }

    // Match regex paths: `path: /^\/v1\/contacts\/([^/]+)$/`
    const regexMatch = line.match(/path:\s*\/\^(.*?)\$\//);
    if (regexMatch) {
      const converted = regexToOpenApiPath(regexMatch[1]);
      if (converted) {
        const method = findMethodNearPath(lines, i);
        routes.push({ path: converted, method });
      }
      continue;
    }

    // Pre-router paths matched via `url.pathname === "/..."` in the fetch handler
    const preRouterMatch = line.match(/url\.pathname\s*===\s*"([^"]+)"/);
    if (preRouterMatch && !seenPreRouterPaths.has(preRouterMatch[1])) {
      seenPreRouterPaths.add(preRouterMatch[1]);
      routes.push({ path: preRouterMatch[1], method: null });
    }
  }

  return routes;
}

/**
 * Looks for a `method: "..."` declaration near a `path:` line.
 * In the route table, method is always declared within a few lines
 * of path (same object literal). We scan up to 3 lines after path.
 */
function findMethodNearPath(
  lines: string[],
  pathLineIndex: number,
): string | null {
  // method can appear before or after path within the same object.
  // Scan a small window around the path line, stopping at object boundaries.
  for (let offset = -3; offset <= 3; offset++) {
    const idx = pathLineIndex + offset;
    if (idx < 0 || idx >= lines.length) continue;
    const methodMatch = lines[idx].match(/method:\s*"([A-Z]+)"/);
    if (methodMatch) return methodMatch[1];
  }
  return null;
}

/** Deduplicated, sorted list of unique route paths. */
function extractRoutePathsFromSource(): string[] {
  const paths = new Set(extractRoutesFromSource().map((r) => r.path));
  return [...paths].sort();
}

/**
 * Converts an escaped regex path to an OpenAPI-style path.
 * e.g. `\/v1\/contacts\/([^/]+)` → `/v1/contacts/{id}`
 *
 * Each capture group `([^/]+)` is replaced with `{paramN}` where N is the
 * 1-based index of the group.
 */
function regexToOpenApiPath(escaped: string): string | null {
  // Unescape forward slashes
  let path = escaped.replace(/\\\//g, "/");

  // Zero-width lookarounds constrain which parameter values are accepted,
  // but they do not change the structural path shape we compare to the schema.
  path = path.replace(/\(\?(?:=|!|<=|<!).*?\)/g, "");

  // Replace capture groups with numbered params.
  // Handles both `([^/]+)` (single segment) and `(.+)` (greedy) patterns.
  let paramIndex = 0;
  path = path.replace(/\(\[\^\/\]\+\)|\(\.\+\)/g, () => {
    paramIndex++;
    return `{param${paramIndex}}`;
  });

  // Strip optional trailing slash (`/?`) — common in route regexes
  path = path.replace(/\/\?$/, "");

  // If there are remaining regex constructs we can't convert, skip
  if (/[\\()\[\].*+?{}|^$]/.test(path.replace(/\{param\d+\}/g, ""))) {
    return null;
  }

  return path;
}

// ── Routes that are intentionally undocumented in the OpenAPI schema ──
// Each entry must have a comment explaining why it's excluded.
const EXCLUDED_FROM_SCHEMA = new Set([
  // Browser relay WebSocket upgrade — handled pre-router, not a REST endpoint
  "/v1/browser-relay",

  // Runtime proxy catch-all — documented as /{path} in the schema
  "catch-all",

  // Internal-only endpoint called by the platform via vembda — not public API
  "/v1/internal/oauth/chrome-extension/token",
]);

// ── Schema paths that don't map to a discrete route definition ──
// These are documented in the schema but correspond to pre-router logic
// or catch-all behavior rather than an explicit route table entry.
const SCHEMA_ONLY_PATHS = new Set([
  // Served by the catch-all runtime proxy, not a dedicated route
  "/{path}",
]);

describe("route-schema sync guard", () => {
  const schema = buildSchema() as { paths: Record<string, unknown> };
  const schemaPaths = new Set(Object.keys(schema.paths));
  const routePaths = extractRoutePathsFromSource();

  test("every route path should have a corresponding schema entry", () => {
    const missing: string[] = [];

    for (const routePath of routePaths) {
      if (EXCLUDED_FROM_SCHEMA.has(routePath)) continue;

      // The catch-all regex `/^\//` matches everything — it maps to /{path} in the schema
      if (routePath === "/") continue;

      // Normalize regex-extracted parameterized paths to match schema naming.
      // Route regexes use positional params ({param1}, {param2}) while the
      // schema uses semantic names. We check if any schema path matches
      // structurally (same segments, params in same positions).
      const matched = findMatchingSchemaPath(routePath, schemaPaths);
      if (!matched) {
        missing.push(routePath);
      }
    }

    expect(missing).toEqual([]);
  });

  test("every schema path should have a corresponding route", () => {
    const orphaned: string[] = [];

    for (const schemaPath of schemaPaths) {
      if (SCHEMA_ONLY_PATHS.has(schemaPath)) continue;

      const matched = findMatchingRoutePath(schemaPath, routePaths);
      if (!matched) {
        orphaned.push(schemaPath);
      }
    }

    expect(orphaned).toEqual([]);
  });

  test("HTTP methods for each path should match between routes and schema", () => {
    const routes = extractRoutesFromSource();
    const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
    type HttpMethod = (typeof HTTP_METHODS)[number];

    const mismatches: string[] = [];

    // Build a map of path → set of methods from the route table.
    // Routes without an explicit method match any method — skip those
    // since the guard can't know which methods they actually handle.
    const routeMethodsByPath = new Map<string, Set<HttpMethod>>();
    for (const route of routes) {
      if (EXCLUDED_FROM_SCHEMA.has(route.path)) continue;
      if (route.path === "/") continue; // catch-all
      if (!route.method) continue; // any-method routes can't be compared

      const normalizedPath = resolveSchemaPath(route.path, schemaPaths);
      if (!normalizedPath) continue;

      let methods = routeMethodsByPath.get(normalizedPath);
      if (!methods) {
        methods = new Set();
        routeMethodsByPath.set(normalizedPath, methods);
      }
      methods.add(route.method.toLowerCase() as HttpMethod);
    }

    // For each path that has explicit methods in the route table,
    // verify the schema documents exactly the same set of methods.
    for (const [path, routeMethods] of routeMethodsByPath) {
      const schemaEntry = (
        schema.paths as Record<string, Record<string, unknown>>
      )[path];
      if (!schemaEntry) continue; // path-level mismatch is caught by the other tests

      const schemaMethods = new Set(
        HTTP_METHODS.filter((m) => m in schemaEntry),
      );

      const missingFromSchema = [...routeMethods].filter(
        (m) => !schemaMethods.has(m),
      );
      const extraInSchema = [...schemaMethods].filter(
        (m) => !routeMethods.has(m),
      );

      for (const m of missingFromSchema) {
        mismatches.push(
          `${m.toUpperCase()} ${path}: in routes but not in schema`,
        );
      }
      for (const m of extraInSchema) {
        mismatches.push(
          `${m.toUpperCase()} ${path}: in schema but not in routes`,
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  test("excluded routes list contains only paths that actually exist", () => {
    // Catch-all is a special synthetic entry
    const actualPaths = new Set(routePaths);
    const stale = [...EXCLUDED_FROM_SCHEMA].filter(
      (p) => p !== "catch-all" && !actualPaths.has(p),
    );

    expect(stale).toEqual([]);
  });

  test("regex route normalization ignores negative lookaheads", () => {
    expect(
      regexToOpenApiPath(String.raw`\/v1\/contacts\/(?!invites$)([^/]+)`),
    ).toBe("/v1/contacts/{param1}");
  });
});

/**
 * Returns the schema path string that matches a route path, or null if none.
 * Used by the method comparison test to look up schema entries by path.
 */
function resolveSchemaPath(
  routePath: string,
  schemaPaths: Set<string>,
): string | null {
  if (schemaPaths.has(routePath)) return routePath;

  const routeSegments = routePath.split("/");

  for (const schemaPath of schemaPaths) {
    const schemaSegments = schemaPath.split("/");
    if (routeSegments.length !== schemaSegments.length) continue;

    const matches = routeSegments.every((seg, i) => {
      if (seg === schemaSegments[i]) return true;
      if (seg.startsWith("{") && schemaSegments[i].startsWith("{")) return true;
      return false;
    });

    if (matches) return schemaPath;
  }

  return null;
}

/**
 * Checks if a route path (possibly with {paramN} placeholders) matches
 * any schema path (with semantic parameter names like {contactId}).
 *
 * Two paths match if they have the same number of segments and every
 * non-parameter segment is identical.
 */
function findMatchingSchemaPath(
  routePath: string,
  schemaPaths: Set<string>,
): boolean {
  // Direct match
  if (schemaPaths.has(routePath)) return true;

  const routeSegments = routePath.split("/");

  for (const schemaPath of schemaPaths) {
    const schemaSegments = schemaPath.split("/");
    if (routeSegments.length !== schemaSegments.length) continue;

    const matches = routeSegments.every((seg, i) => {
      if (seg === schemaSegments[i]) return true;
      // Both are parameters
      if (seg.startsWith("{") && schemaSegments[i].startsWith("{")) return true;
      return false;
    });

    if (matches) return true;
  }

  return false;
}

/**
 * Checks if a schema path matches any route path, accounting for
 * parameterized segments.
 */
function findMatchingRoutePath(
  schemaPath: string,
  routePaths: string[],
): boolean {
  if (routePaths.includes(schemaPath)) return true;

  const schemaSegments = schemaPath.split("/");

  for (const routePath of routePaths) {
    const routeSegments = routePath.split("/");
    if (schemaSegments.length !== routeSegments.length) continue;

    const matches = schemaSegments.every((seg, i) => {
      if (seg === routeSegments[i]) return true;
      if (seg.startsWith("{") && routeSegments[i].startsWith("{")) return true;
      return false;
    });

    if (matches) return true;
  }

  return false;
}
