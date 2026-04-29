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
 */

import { getLogger } from "../logger.js";
import { ipcCallAssistant } from "./assistant-client.js";

const log = getLogger("route-schema-cache");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoutePolicy {
  scopes: string[];
  principalTypes: string[];
}

export interface RouteSchemaEntry {
  operationId: string;
  endpoint: string;
  method: string;
  /** Resolved policy for scope/principal enforcement. Undefined = no policy. */
  policy?: RoutePolicy;
}

export interface RouteMatch {
  operationId: string;
  pathParams: Record<string, string>;
  /** Resolved policy for scope/principal enforcement. Undefined = no policy. */
  policy?: RoutePolicy;
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

function buildCompiled(entries: RouteSchemaEntry[]): CompiledRoute[] {
  return entries.map(compileEndpoint);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const RETRY_DELAY_MS = 3_000;
const MAX_RETRIES = 10;

/**
 * Fetch the route schema from the assistant daemon and update the cache.
 * Retries with backoff until the daemon responds or MAX_RETRIES is
 * exhausted — the daemon may not be up yet when the gateway starts.
 */
export async function refreshRouteSchema(): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await ipcCallAssistant("get_route_schema");

      if (Array.isArray(result)) {
        cachedSchema = result as RouteSchemaEntry[];
        compiledRoutes = buildCompiled(cachedSchema);
        log.info(
          { routeCount: cachedSchema.length, attempt },
          "Route schema cache refreshed",
        );
        return true;
      }
    } catch (err) {
      log.warn(
        { err, attempt, maxRetries: MAX_RETRIES },
        "Route schema fetch failed",
      );
    }

    if (attempt < MAX_RETRIES) {
      log.info(
        { attempt, maxRetries: MAX_RETRIES, retryInMs: RETRY_DELAY_MS },
        "Assistant daemon not ready; retrying route schema fetch",
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
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
    return {
      operationId: compiled.entry.operationId,
      pathParams,
      policy: compiled.entry.policy,
    };
  }
  return undefined;
}

/** Get the full cached schema (e.g. for diagnostics). */
export function getCachedRouteSchema(): readonly RouteSchemaEntry[] {
  return cachedSchema;
}

/** Get the number of cached routes. */
export function getCachedRouteCount(): number {
  return cachedSchema.length;
}
