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

import type { z } from "zod";

import { enforcePolicy, getPolicy } from "./auth/route-policy.js";
import type { AuthContext } from "./auth/types.js";
import { httpError } from "./http-errors.js";
import { withErrorHandling } from "./middleware/error-handler.js";

// ---------------------------------------------------------------------------
// Route definition types
// ---------------------------------------------------------------------------

/** Extracted parameters from parameterized route matches. */
export type RouteParams = Record<string, string>;

/** The context available to every route handler. */
export interface RouteContext {
  req: Request;
  url: URL;
  server: ReturnType<typeof Bun.serve>;
  authContext: AuthContext;
  params: RouteParams;
}

/** Schema for an OpenAPI query parameter. */
export interface RouteQueryParam {
  name: string;
  /** OpenAPI-style JSON Schema type (e.g. "string", "integer"). Defaults to "string". */
  type?: string;
  required?: boolean;
  description?: string;
  /** Inline JSON Schema for the parameter (overrides `type` when present). */
  schema?: Record<string, unknown>;
}

/** Zod schema used to describe a request or response body.
 * The generate-openapi script converts these to JSON Schema via z.toJSONSchema(). */
export type RouteBodySchema = z.ZodType;

/**
 * Description for a non-200 response variant. Used when an endpoint has
 * meaningful alternate response shapes that clients should handle (e.g.
 * 502 `fetch_failed` on POST /v1/migrations/import when the URL body path
 * can't reach the upstream bundle host).
 */
export interface RouteAdditionalResponse {
  description: string;
  /** Zod schema or plain JSON Schema fragment. */
  schema?: RouteBodySchema | Record<string, unknown>;
}

/**
 * Request-body variant keyed by Content-Type. Use this when an endpoint
 * accepts multiple body shapes (e.g. `application/octet-stream` OR
 * `application/json`). For the common single-JSON case, use `requestBody`.
 */
export interface RouteRequestBodyVariant {
  contentType: string;
  /** Zod schema or plain JSON Schema fragment. Plain objects are embedded verbatim. */
  schema: RouteBodySchema | Record<string, unknown>;
}

/**
 * A single route entry in the declarative table.
 *
 * - `endpoint`: The endpoint pattern after `/v1/`. Use `:paramName` for
 *   single-segment params (e.g. `calls/:id/cancel`) or `:paramName*` for
 *   catch-all params that match across slashes (e.g. `interfaces/:path*`).
 * - `method`: HTTP method (GET, POST, DELETE, PATCH, PUT).
 * - `handler`: Async function that produces the Response.
 * - `policyKey`: Override the policy lookup key. When omitted the router
 *   derives it from the endpoint pattern (stripping param segments).
 */
export interface RouteDefinition {
  endpoint: string;
  method: string;
  handler: (ctx: RouteContext) => Promise<Response> | Response;
  policyKey?: string;

  // -- OpenAPI metadata (optional) ------------------------------------------
  /** Short summary shown next to the operation in generated docs. */
  summary?: string;
  /** Longer description (Markdown-safe) for the operation. */
  description?: string;
  /** Grouping tags (e.g. "secrets", "identity"). Auto-derived from the route module filename when omitted. */
  tags?: string[];
  /** Query parameter definitions for the operation. */
  queryParams?: RouteQueryParam[];
  /** Zod schema for the request body (POST/PUT/PATCH/DELETE). */
  requestBody?: RouteBodySchema;
  /**
   * Alternate request-body variants keyed by Content-Type. When set,
   * overrides `requestBody` in the generated OpenAPI spec — use this for
   * endpoints that accept multiple body shapes on the same URL (e.g.
   * raw bytes OR JSON URL).
   */
  requestBodies?: RouteRequestBodyVariant[];
  /** Zod schema for the 200 response body. */
  responseBody?: RouteBodySchema;
  /** Additional non-200 responses documented in the generated OpenAPI spec. */
  additionalResponses?: Record<string, RouteAdditionalResponse>;
}

// ---------------------------------------------------------------------------
// Compiled route — internal representation with pre-built regex
// ---------------------------------------------------------------------------

interface CompiledRoute {
  def: RouteDefinition;
  regex: RegExp;
  paramNames: string[];
  /** Policy key used for enforcePolicy() lookups. */
  resolvedPolicyKey: string;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class HttpRouter {
  private compiledRoutes: CompiledRoute[] = [];

  constructor(routes: RouteDefinition[]) {
    for (const def of routes) {
      this.compiledRoutes.push(compileRoute(def));
    }
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

      // Enforce route-level scope/principal policy.
      // Try method-specific key first (e.g. "messages:POST"), then plain key.
      const methodKey = `${compiled.resolvedPolicyKey}:${req.method}`;
      const policyKey = getPolicy(methodKey)
        ? methodKey
        : compiled.resolvedPolicyKey;
      const policyDenied = enforcePolicy(policyKey, authContext);
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

/**
 * Compile a route definition into a regex + param list + policy key.
 *
 * Endpoint patterns like `calls/:id/cancel` become:
 *   regex: /^calls\/([^/]+)\/cancel$/
 *   paramNames: ["id"]
 *   resolvedPolicyKey: "calls/cancel" (params stripped)
 */
function compileRoute(def: RouteDefinition): CompiledRoute {
  const paramNames: string[] = [];
  const policySegments: string[] = [];

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
        return "([^/]+)";
      }
      policySegments.push(segment);
      return escapeRegex(segment);
    })
    .join("\\/");

  const regex = new RegExp(`^${regexSource}$`);

  // If the definition specifies a policyKey, use it. Otherwise derive from
  // the non-param segments (e.g. `calls/:id/cancel` -> `calls/cancel`).
  const resolvedPolicyKey = def.policyKey ?? policySegments.join("/");

  return { def, regex, paramNames, resolvedPolicyKey };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
