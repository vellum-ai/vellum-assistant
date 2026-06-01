/**
 * Cached route schema fetched from the assistant daemon via IPC.
 *
 * The gateway calls `get_route_schema` on startup and caches the result
 * in memory. This cache is used by the runtime proxy to determine whether
 * an inbound HTTP request can be served over IPC instead of being forwarded
 * as HTTP to the daemon.
 *
 * The cache is refreshed on startup and when the gateway reconnects to the
 * assistant's IPC socket.  A future `route_schema_changed` event will allow
 * reactive updates without polling.
 *
 * Each schema entry carries a `policy` field — the resolved scope /
 * principal-type requirements the daemon's HTTP path enforces via
 * `enforcePolicy()`. The gateway's IPC proxy uses this directly (see
 * `getCachedRoutePolicy`), eliminating the parallel gateway-side policy
 * table that used to be maintained by hand and silently drifted whenever a
 * route was added (ATL-315). When `policy` is `null` the daemon has
 * registered the route as intentionally unprotected (health, debug, ...);
 * the gateway respects that.
 */

import { z } from "zod";

import { getLogger } from "../logger.js";
import { ipcCallAssistant } from "./assistant-client.js";

const log = getLogger("route-schema-cache");

// ---------------------------------------------------------------------------
// Wire schema — validated at every refresh so old daemons (missing the
// `policy` field) fail loudly instead of silently fail-open.
// ---------------------------------------------------------------------------

const routeSchemaPolicySchema = z.object({
  requiredScopes: z.array(z.string()).readonly(),
  allowedPrincipalTypes: z.array(z.string()).readonly(),
});

const routeSchemaEntrySchema = z.object({
  operationId: z.string(),
  endpoint: z.string(),
  method: z.string(),
  // Nullable + required: `null` means the daemon explicitly declared the
  // route as unprotected; missing `policy` field means the daemon is too
  // old to know about policy serialization and should fail validation so
  // the gateway can't accidentally proxy with no enforcement.
  policy: routeSchemaPolicySchema.nullable(),
});

const routeSchemaResponseSchema = z.array(routeSchemaEntrySchema);

export type RouteSchemaPolicy = z.infer<typeof routeSchemaPolicySchema>;
export type RouteSchemaEntry = z.infer<typeof routeSchemaEntrySchema>;

export interface RouteMatch {
  operationId: string;
  pathParams: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Compiled route — pre-built regex for parameterized endpoint matching
// ---------------------------------------------------------------------------

interface CompiledRoute {
  entry: RouteSchemaEntry;
  regex: RegExp;
  paramNames: string[];
}

function compileEndpoint(entry: RouteSchemaEntry): CompiledRoute {
  const paramNames: string[] = [];
  const regexSource = entry.endpoint
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        const isCatchAll = segment.endsWith("*");
        const name = isCatchAll ? segment.slice(1, -1) : segment.slice(1);
        paramNames.push(name);
        return isCatchAll ? "(.+)" : "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("\\/");

  return {
    entry,
    regex: new RegExp(`^${regexSource}$`),
    paramNames,
  };
}

// ---------------------------------------------------------------------------
// Cache state
// ---------------------------------------------------------------------------

let cachedSchema: RouteSchemaEntry[] = [];
let compiledRoutes: CompiledRoute[] = [];
const policyByOperationId = new Map<string, RouteSchemaPolicy | null>();

function buildCompiled(entries: RouteSchemaEntry[]): CompiledRoute[] {
  return entries.map(compileEndpoint);
}

function rebuildPolicyIndex(entries: RouteSchemaEntry[]): void {
  policyByOperationId.clear();
  for (const entry of entries) {
    policyByOperationId.set(entry.operationId, entry.policy);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const RETRY_DELAY_MS = 3_000;
const MAX_RETRIES = 10;

/**
 * Fetch the route schema from the assistant daemon and update the cache.
 *
 * Two distinct failure modes:
 *
 * - **Transport / IPC error**: retried with backoff. The daemon may not
 *   be up yet at gateway startup.
 *
 * - **Schema-validation failure**: terminal. The wire shape is fixed by
 *   the gateway↔daemon contract and ships together; if validation
 *   fails, the daemon is on an incompatible version. Retrying won't
 *   help and the cache retains whatever it had before the call (or
 *   stays empty), causing IPC proxying to fail closed.
 */
export async function refreshRouteSchema(): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let result: unknown;
    try {
      result = await ipcCallAssistant("get_route_schema");
    } catch (err) {
      log.warn(
        { err, attempt, maxRetries: MAX_RETRIES },
        "Route schema fetch failed (transport error)",
      );
      if (attempt < MAX_RETRIES) {
        log.info(
          { attempt, maxRetries: MAX_RETRIES, retryInMs: RETRY_DELAY_MS },
          "Assistant daemon not ready; retrying route schema fetch",
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
      continue;
    }

    const parsed = routeSchemaResponseSchema.safeParse(result);
    if (parsed.success) {
      cachedSchema = parsed.data;
      compiledRoutes = buildCompiled(cachedSchema);
      rebuildPolicyIndex(cachedSchema);
      log.info(
        { routeCount: cachedSchema.length, attempt },
        "Route schema cache refreshed",
      );
      return true;
    }

    // Validation failure is terminal — see docstring above.
    log.warn(
      { issues: parsed.error.issues, attempt },
      "Route schema rejected: payload did not match expected shape " +
        "(missing `policy` field?). Refusing to cache; IPC proxy will " +
        "fail closed.",
    );
    return false;
  }

  log.warn(
    { maxRetries: MAX_RETRIES },
    "Failed to fetch route schema after all retries",
  );
  return false;
}

/**
 * Match an HTTP method + path against the cached route schema.
 *
 * The `path` should be the portion after `/v1/` (e.g. `acp/abc123/steer`
 * for a request to `/v1/acp/abc123/steer`).
 *
 * Returns the operationId and extracted path params on match, or
 * `undefined` if no cached route matches.
 */
export function matchRoute(
  method: string,
  path: string,
): RouteMatch | undefined {
  const upperMethod = method.toUpperCase();
  for (const compiled of compiledRoutes) {
    if (compiled.entry.method.toUpperCase() !== upperMethod) continue;
    const match = path.match(compiled.regex);
    if (!match) continue;

    const pathParams: Record<string, string> = {};
    for (let i = 0; i < compiled.paramNames.length; i++) {
      pathParams[compiled.paramNames[i]] = decodeURIComponent(match[i + 1]);
    }
    return { operationId: compiled.entry.operationId, pathParams };
  }
  return undefined;
}

/**
 * Look up the policy for an operationId from the cached route schema.
 *
 * Returns:
 * - the policy when the daemon shipped one for this operation,
 * - `null` when the daemon explicitly declared the route as unprotected,
 * - `undefined` when the operationId isn't in the cache at all.
 *
 * Callers must distinguish `null` (proceed without enforcement) from
 * `undefined` (operation not known — should not have reached enforcement
 * because `matchRoute` would have returned undefined first; treat as a
 * server bug and reject).
 */
export function getCachedRoutePolicy(
  operationId: string,
): RouteSchemaPolicy | null | undefined {
  if (!policyByOperationId.has(operationId)) return undefined;
  return policyByOperationId.get(operationId) ?? null;
}

/** Get the full cached schema (e.g. for diagnostics). */
export function getCachedRouteSchema(): readonly RouteSchemaEntry[] {
  return cachedSchema;
}

/** Get the number of cached routes. */
export function getCachedRouteCount(): number {
  return cachedSchema.length;
}
