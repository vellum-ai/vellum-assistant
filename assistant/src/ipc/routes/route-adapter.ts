/**
 * Adapts transport-agnostic RouteDefinitions into IpcRoutes for the
 * AssistantIpcServer.
 *
 * Supports two payload shapes:
 *
 * 1. **Structured** (gateway IPC proxy): params contain `pathParams`,
 *    `queryParams`, `body`, and/or `headers` keys — passed through to the
 *    handler as-is.
 *
 * 2. **Flat** (legacy CLI callers): params is a flat bag of key-value
 *    pairs, treated as both pathParams and body for backward compat.
 *    This fallback will be removed once all callers migrate.
 */

import type { RouteHandlerArgs } from "../../runtime/routes/types.js";
import type { RouteDefinition } from "../../runtime/routes/types.js";
import type { IpcRoute } from "../assistant-server.js";

const STRUCTURED_KEYS = new Set([
  "pathParams",
  "queryParams",
  "body",
  "headers",
]);

function isStructuredPayload(params: Record<string, unknown>): boolean {
  const keys = Object.keys(params);
  return keys.length > 0 && keys.every((k) => STRUCTURED_KEYS.has(k));
}

export function routeDefinitionsToIpcRoutes(
  routes: RouteDefinition[],
): IpcRoute[] {
  return routes
    .filter((r) => !r.requireGuardian)
    .map((r) => ({
      method: r.operationId,
      handler: (params?: Record<string, unknown>) => {
        let args: RouteHandlerArgs;

        if (params && isStructuredPayload(params)) {
          args = {
            pathParams: params.pathParams as Record<string, string> | undefined,
            queryParams: params.queryParams as
              | Record<string, string>
              | undefined,
            body: params.body as Record<string, unknown> | undefined,
            headers: params.headers as Record<string, string> | undefined,
          };
        } else {
          const stringParams: Record<string, string> = {};
          if (params) {
            for (const [k, v] of Object.entries(params)) {
              if (typeof v === "string") stringParams[k] = v;
            }
          }
          args = {
            pathParams: stringParams,
            queryParams: stringParams,
            body: params,
          };
        }

        return r.handler(args);
      },
    }));
}
