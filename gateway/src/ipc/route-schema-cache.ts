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

export interface RouteSchemaEntry {
  operationId: string;
  endpoint: string;
  method: string;
}

// ---------------------------------------------------------------------------
// Cache state
// ---------------------------------------------------------------------------

let cachedSchema: RouteSchemaEntry[] = [];
let operationIdByRoute = new Map<string, string>();

function routeKey(method: string, endpoint: string): string {
  return `${method.toUpperCase()} ${endpoint}`;
}

function buildIndex(entries: RouteSchemaEntry[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of entries) {
    index.set(routeKey(entry.method, entry.endpoint), entry.operationId);
  }
  return index;
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
        operationIdByRoute = buildIndex(cachedSchema);
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
 * Look up the operationId for an HTTP method + endpoint pattern.
 * Returns `undefined` if the route is not in the schema cache.
 */
export function lookupOperationId(
  method: string,
  endpoint: string,
): string | undefined {
  return operationIdByRoute.get(routeKey(method, endpoint));
}

/** Get the full cached schema (e.g. for diagnostics). */
export function getCachedRouteSchema(): readonly RouteSchemaEntry[] {
  return cachedSchema;
}

/** Get the number of cached routes. */
export function getCachedRouteCount(): number {
  return cachedSchema.length;
}
