/**
 * Declarative route table and dispatch for the runtime HTTP server.
 *
 * Replaces the if-ladder in `dispatchEndpoint` and
 * `handleAuthenticatedRequest` with a typed array of route definitions
 * that the router matches against.
 *
 * Parameterized route normalization for policy lookup is handled here,
 * absorbing what was previously `PARAMETERIZED_ROUTE_PATTERNS` and
 * `normalizeEndpointForPolicy`.
 */

import { enforcePolicy } from "./auth/route-policy.js";
import type { AuthContext } from "./auth/types.js";
import { httpError } from "./http-errors.js";
import type { HTTPRouteDefinition, RouteParams } from "./http-router-types.js";
import { withErrorHandling } from "./middleware/error-handler.js";
import { routeDefinitionsToHTTPRoutes } from "./routes/http-adapter.js";
import { ROUTES } from "./routes/index.js";
import type { RouteLoggingConfig } from "./routes/types.js";

// ---------------------------------------------------------------------------
// Compiled route — internal representation with pre-built regex
// ---------------------------------------------------------------------------

interface CompiledRoute {
  def: HTTPRouteDefinition;
  regex: RegExp;
  paramNames: string[];
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class HttpRouter {
  private compiledRoutes: CompiledRoute[] = [];

  constructor() {
    for (const def of routeDefinitionsToHTTPRoutes(ROUTES)) {
      this.compiledRoutes.push(compileRoute(def));
    }
  }

  /**
   * Resolve the request-logging metadata for an incoming request without
   * invoking the handler. Returns the matched route's logging config plus
   * a stable counter key derived from operationId (or method+endpoint as
   * a fallback when operationId is not set).
   *
   * Called by the HTTP server *before* `withRequestLogging` so the
   * middleware can decide whether to suppress the per-request success log.
   * Returns `null` when no route matches or the matched route opts out of
   * custom logging — both cases mean "use the default log-every-request".
   */
  findLoggingMetadata(
    method: string,
    endpoint: string,
  ): { counterKey: string; config: RouteLoggingConfig } | null {
    const normalized = endpoint.endsWith("/")
      ? endpoint.slice(0, -1)
      : endpoint;
    for (const compiled of this.compiledRoutes) {
      if (compiled.def.method !== method) continue;
      if (!compiled.regex.test(normalized)) continue;
      const config = compiled.def.logging;
      if (!config) return null;
      const counterKey =
        compiled.def.operationId ?? `${method} ${compiled.def.endpoint}`;
      return { counterKey, config };
    }
    return null;
  }

  /**
   * Dispatch a request to the matching route handler.
   *
   * Returns `null` when no route matches (caller should return 404).
   */
  async dispatch(
    endpoint: string,
    req: Request,
    url: URL,
    server: ReturnType<typeof Bun.serve>,
    authContext: AuthContext,
  ): Promise<Response | null> {
    // Normalize trailing slashes so "/integrations/twilio/config/" matches
    // a route defined as "integrations/twilio/config".
    const normalized = endpoint.endsWith("/")
      ? endpoint.slice(0, -1)
      : endpoint;

    for (const compiled of this.compiledRoutes) {
      if (compiled.def.method !== req.method) continue;

      const match = normalized.match(compiled.regex);
      if (!match) continue;

      // Extract named params
      const params: RouteParams = {};
      for (let i = 0; i < compiled.paramNames.length; i++) {
        try {
          params[compiled.paramNames[i]] = decodeURIComponent(match[i + 1]);
        } catch {
          return httpError(
            "BAD_REQUEST",
            "Malformed percent-encoding in URL path parameter",
            400,
          );
        }
      }

      // Enforce route-level scope/principal policy. The policy
      // travels with the RouteDefinition itself — no side-registry
      // lookup, no derivation, no key mismatch.
      const policyDenied = enforcePolicy(
        compiled.def.endpoint,
        compiled.def.policy,
        authContext,
      );
      if (policyDenied) return policyDenied;

      return withErrorHandling(endpoint, () =>
        Promise.resolve(
          compiled.def.handler({ req, url, server, authContext, params }),
        ),
      );
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Compilation helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Path-param type → regex fragment
// ---------------------------------------------------------------------------

const UUID_PATTERN =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/** Map of param type → regex capture group (without the surrounding parens). */
const PARAM_TYPE_PATTERNS: Record<string, string> = {
  uuid: UUID_PATTERN,
};

/**
 * Compile a route definition into a regex + param list.
 *
 * Endpoint patterns like `calls/:id/cancel` become:
 *   regex: /^calls\/([^/]+)\/cancel$/
 *   paramNames: ["id"]
 *
 * When the route declares `pathParams` with a `type` constraint (e.g.
 * `{ name: "id", type: "uuid" }`), the capture group is narrowed to
 * only match values of that type. This prevents parameterized routes
 * from shadowing literal sibling routes regardless of declaration order.
 *
 * Policies are declared inline on the RouteDefinition itself —
 * no derivation, no lookup key.
 */
function compileRoute(def: HTTPRouteDefinition): CompiledRoute {
  const paramNames: string[] = [];

  // Build a lookup for typed path params.
  const paramTypeMap = new Map<string, string>();
  if (def.pathParams) {
    for (const pp of def.pathParams) {
      if (pp.type && pp.type !== "string") {
        paramTypeMap.set(pp.name, pp.type);
      }
    }
  }

  const regexSource = def.endpoint
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        const isCatchAll = segment.endsWith("*");
        const name = isCatchAll ? segment.slice(1, -1) : segment.slice(1);
        paramNames.push(name);
        if (isCatchAll) {
          // Catch-all: match one or more chars including slashes. Must be
          // the last segment — absorb all remaining path components.
          return "(.+)";
        }
        const typePattern = PARAM_TYPE_PATTERNS[paramTypeMap.get(name) ?? ""];
        return typePattern ? `(${typePattern})` : "([^/]+)";
      }
      return escapeRegex(segment);
    })
    .join("\\/");

  const regex = new RegExp(`^${regexSource}$`);

  return { def, regex, paramNames };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
