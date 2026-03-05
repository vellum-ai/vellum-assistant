import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSchema } from "../schema.js";

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
function extractRoutePathsFromSource(): string[] {
  const src = readFileSync(
    join(import.meta.dirname!, "..", "index.ts"),
    "utf-8",
  );

  const paths = new Set<string>();

  // Match string literal paths: `path: "/some/path"`
  const stringPathRe = /path:\s*"([^"]+)"/g;
  for (const m of src.matchAll(stringPathRe)) {
    paths.add(m[1]);
  }

  // Match regex paths and convert to OpenAPI-style parameterized paths.
  // Pattern: `path: /^\/v1\/contacts\/([^/]+)$/`
  const regexPathRe = /path:\s*\/\^(.*?)\$\//g;
  for (const m of src.matchAll(regexPathRe)) {
    const converted = regexToOpenApiPath(m[1]);
    if (converted) paths.add(converted);
  }

  // Pre-router paths matched via `url.pathname === "/..."` in the fetch handler
  const preRouterRe = /url\.pathname\s*===\s*"([^"]+)"/g;
  for (const m of src.matchAll(preRouterRe)) {
    paths.add(m[1]);
  }

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

  // Replace capture groups with numbered params.
  // Handles both `([^/]+)` (single segment) and `(.+)` (greedy) patterns.
  let paramIndex = 0;
  path = path.replace(/\(\[\^\/\]\+\)|\(\.\+\)/g, () => {
    paramIndex++;
    return `{param${paramIndex}}`;
  });

  // If there are remaining regex constructs we can't convert, skip
  if (/[\\()\[\].*+?{}|^$]/.test(path.replace(/\{param\d+\}/g, ""))) {
    return null;
  }

  return path;
}

// ── Routes that are intentionally undocumented in the OpenAPI schema ──
// Each entry must have a comment explaining why it's excluded.
const EXCLUDED_FROM_SCHEMA = new Set([
  // Internal-only route, not reachable from the public internet
  "/internal/telegram/reconcile",

  // Duplicate webhook paths for Twilio call routing — the canonical
  // paths under /webhooks/ are documented instead
  "/v1/calls/twilio/voice-webhook",
  "/v1/calls/twilio/status",
  "/v1/calls/twilio/connect-action",
  "/v1/calls/relay",

  // Browser relay WebSocket upgrade — handled pre-router, not a REST endpoint
  "/v1/browser-relay",

  // Runtime proxy catch-all — documented as /{path} in the schema
  "catch-all",
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

  test("excluded routes list contains only paths that actually exist", () => {
    // Catch-all is a special synthetic entry
    const actualPaths = new Set(routePaths);
    const stale = [...EXCLUDED_FROM_SCHEMA].filter(
      (p) => p !== "catch-all" && !actualPaths.has(p),
    );

    expect(stale).toEqual([]);
  });
});

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
