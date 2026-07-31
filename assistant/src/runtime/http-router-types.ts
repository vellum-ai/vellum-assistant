/**
 * HTTP route definition vocabulary for the runtime HTTP server: the shape of a
 * route entry (`HTTPRouteDefinition`), the per-handler context (`RouteContext`),
 * and the OpenAPI metadata types that hang off them. Consumed by the router
 * (`http-router.ts`) and the transport adapter (`routes/http-adapter.ts`).
 */

import type { z } from "zod";

import type { RoutePolicy } from "./auth/route-policy.js";
import type { AuthContext } from "./auth/types.js";
import type {
  RouteLoggingConfig,
  RoutePathParam,
  RouteRequestBody,
  RouteResponseBody,
} from "./routes/types.js";

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
 * A single route entry in the declarative table.
 *
 * - `endpoint`: The endpoint pattern after `/v1/`. Use `:paramName` for
 *   single-segment params (e.g. `calls/:id/cancel`) or `:paramName*` for
 *   catch-all params that match across slashes (e.g. `interfaces/:path*`).
 * - `method`: HTTP method (GET, POST, DELETE, PATCH, PUT).
 * - `handler`: Async function that produces the Response.
 * - `policy`: Scope + principal-type policy for this route, or `null`
 *   when the route is intentionally unprotected. See
 *   `runtime/auth/route-policy.ts` for the type.
 */
export interface HTTPRouteDefinition {
  endpoint: string;
  method: string;
  handler: (ctx: RouteContext) => Promise<Response> | Response;
  policy: RoutePolicy | null;

  /** Stable identifier used as the IPC method name when served over both transports. */
  operationId?: string;

  /** Typed path parameter constraints. When a param has `type: "uuid"`,
   *  the compiled regex narrows the capture group so it only matches
   *  UUID-shaped segments, preventing shadowing of literal sub-routes. */
  pathParams?: RoutePathParam[];

  // -- OpenAPI metadata (optional) ------------------------------------------
  /** Short summary shown next to the operation in generated docs. */
  summary?: string;
  /** Longer description (Markdown-safe) for the operation. */
  description?: string;
  /** Grouping tags (e.g. "secrets", "identity"). Auto-derived from the route module filename when omitted. */
  tags?: string[];
  /** Query parameter definitions for the operation. */
  queryParams?: RouteQueryParam[];
  /**
   * Request body for POST/PUT/PATCH/DELETE. A bare Zod schema is advertised
   * as `application/json`; use the `{ contentType, schema }` form for non-JSON
   * bodies (e.g. a raw `application/octet-stream` upload).
   */
  requestBody?: RouteRequestBody;
  /**
   * Success response body. A bare Zod schema is advertised as
   * `application/json`; use the `{ contentType, schema }` form for non-JSON
   * responses (e.g. a binary `application/octet-stream` download).
   */
  responseBody?: RouteResponseBody;
  /**
   * HTTP status code for the documented success response. Defaults to 200.
   * Set to "202" for async endpoints that enqueue a job and return
   * immediately — this keeps the generated OpenAPI spec aligned with the
   * handler's actual `status:` value.
   */
  responseStatus?: string;
  /** Additional response codes documented in the generated OpenAPI spec. */
  additionalResponses?: Record<string, RouteAdditionalResponse>;
  /**
   * Per-route request-log control. See `RouteLoggingConfig` in `routes/types.ts`.
   * When omitted, the route uses the default log-every-request behavior.
   */
  logging?: RouteLoggingConfig;
}
