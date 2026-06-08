/**
 * Transport-agnostic route definition served by both the HTTP and IPC servers.
 */

import type { z } from "zod";

import type { RoutePolicy } from "../auth/route-policy.js";

export interface RouteQueryParam {
  name: string;
  type?: string;
  required?: boolean;
  description?: string;
  /** Full JSON Schema object — overrides `type` in generated OpenAPI spec. */
  schema?: Record<string, unknown>;
}

/**
 * Type constraint for a path parameter segment (`:paramName`).
 *
 * When a type is specified the router compiles a narrower regex for the
 * segment — e.g. `uuid` emits `[0-9a-fA-F]{8}-…` instead of the default
 * `[^/]+`. This eliminates ordering ambiguities between parameterized and
 * literal routes (a `/conversations/:id` with `type: "uuid"` will never
 * match `/conversations/search`).
 */
export interface RoutePathParam {
  name: string;
  /** Constrains the matched segment. Defaults to `"string"` (any non-slash chars). */
  type?: "string" | "uuid";
  description?: string;
}

/**
 * Content types a route can declare a request body for. `application/json`
 * is the implicit default when `requestBody` is a bare Zod schema, so it is
 * only spelled out here for the explicit `{ contentType, schema }` form.
 */
export type RouteRequestContentType =
  | "application/json"
  | "application/octet-stream"
  | "multipart/form-data";

/**
 * A route's request body. Either:
 * - a bare Zod schema, which is advertised as `application/json`, or
 * - an explicit `{ contentType, schema }` pair for non-JSON bodies (e.g. a
 *   raw `application/octet-stream` upload). `schema` may be a Zod schema or a
 *   plain JSON Schema fragment (e.g. `{ type: "string", format: "binary" }`).
 *
 * The OpenAPI generator turns this into the operation's `requestBody`, so the
 * generated client SDK describes a real body type instead of `never`. The HTTP
 * adapter parses the body off the request `Content-Type` header, so this field
 * is a codegen signal only and does not change runtime request handling.
 */
export type RouteRequestBody =
  | z.ZodType
  | {
      contentType: RouteRequestContentType;
      schema: z.ZodType | Record<string, unknown>;
    };

/**
 * Content types a route can declare a success response body for.
 * `application/json` is the implicit default when `responseBody` is a bare
 * Zod schema, so it is only spelled out here for the explicit
 * `{ contentType, schema }` form (e.g. a binary `application/octet-stream`
 * download or an `application/gzip` archive).
 */
export type RouteResponseContentType =
  | "application/json"
  | "application/octet-stream"
  | "application/gzip"
  | "application/pdf"
  | "application/zip";

/**
 * A route's success response body. Either:
 * - a bare Zod schema, which is advertised as `application/json`, or
 * - an explicit `{ contentType, schema }` pair for non-JSON responses (e.g. a
 *   binary download). `schema` may be a Zod schema or a plain JSON Schema
 *   fragment (e.g. `{ type: "string", format: "binary" }`, which is not
 *   expressible as a bare Zod type).
 *
 * The OpenAPI generator turns this into the operation's success response, so
 * the generated client SDK describes a real response type (e.g. `Blob`)
 * instead of `unknown`. Handlers serialize their own bytes via `RouteResponse`,
 * so this field is a codegen signal only and does not change runtime
 * response handling.
 */
export type RouteResponseBody =
  | z.ZodType
  | {
      contentType: RouteResponseContentType;
      schema: z.ZodType | Record<string, unknown>;
    };

export interface RouteHandlerArgs {
  pathParams?: Record<string, string>;
  queryParams?: Record<string, string>;
  body?: Record<string, unknown>;
  rawBody?: Uint8Array;
  headers?: Record<string, string>;
  /**
   * Abort signal tied to the client connection. Fired when the client
   * disconnects (e.g. SSE stream closed). The IPC adapter may pass
   * `undefined` when no abort semantic is available.
   */
  abortSignal?: AbortSignal;
}

/**
 * Subset of RouteHandlerArgs available to responseHeaders.
 * Excludes body/rawBody since header computation must be fast
 * and should not depend on the request payload.
 */
export type ResponseHeaderArgs = Pick<
  RouteHandlerArgs,
  "pathParams" | "queryParams" | "headers"
>;

/**
 * Wrapper for handlers that need to set per-response headers alongside
 * a non-JSON body (e.g. binary content with Content-Type, Content-Range).
 *
 * Unlike returning a raw `Response`, this is transport-agnostic — both
 * the HTTP and IPC adapters can interpret it.
 */
export class RouteResponse {
  constructor(
    public readonly body: BodyInit | null,
    public readonly headers: Record<string, string>,
    /**
     * Optional status override. When set, the HTTP adapter uses this
     * instead of the route-level `responseStatus`. This lets the handler
     * correct the status when the route-level callable can't fully
     * determine it (e.g. unparseable Range header → full file at 200,
     * not 206).
     */
    public readonly status?: number,
  ) {}
}

export interface RouteDefinition {
  operationId: string;
  endpoint: string;
  method: string;
  /**
   * Scope + principal-type policy for this route.
   *
   * `null` means the route is intentionally unprotected — health
   * probes, public capability-token endpoints, and the like.
   *
   * A `RoutePolicy` object declares the scopes a caller must hold
   * and which principal types are allowed. Both the HTTP server
   * (`enforcePolicy()`) and the gateway IPC proxy (via the route
   * schema served from `get_route_schema`) read this field.
   *
   * Required so the type system catches every new route — there is
   * no separate registry to forget to update.
   */
  policy: RoutePolicy | null;
  handler: (args: RouteHandlerArgs) => unknown | Promise<unknown>;
  summary?: string;
  description?: string;
  tags?: string[];
  pathParams?: RoutePathParam[];
  queryParams?: RouteQueryParam[];
  requestBody?: RouteRequestBody;
  responseBody?: RouteResponseBody;
  /**
   * HTTP status code for the success response. Defaults to "200".
   * Use "201" for resource creation, "204" for no-content responses.
   * When "204", the HTTP adapter returns an empty body regardless of
   * what the handler returns.
   *
   * Can be a static string or a function that computes the status from
   * request metadata (e.g. returning "206" when a Range header is present).
   */
  responseStatus?: string | ((args: ResponseHeaderArgs) => string);
  /**
   * When true, the HTTP adapter verifies the caller is the bound guardian
   * before invoking the handler. The IPC adapter excludes these routes
   * entirely — they will migrate to the gateway which owns guardian
   * binding long-term.
   */
  requireGuardian?: boolean;
  /**
   * When true, the route is unauthenticated — served pre-auth on HTTP
   * and excluded from IPC registration. Public routes use capability
   * tokens (unguessable IDs) instead of caller auth. Long-term these
   * will be served directly by the gateway (ATL-314).
   */
  isPublic?: boolean;
  /**
   * Response headers for this route. Can be:
   * - A static map of header name → value
   * - A function that computes headers from path/query params + request headers
   *
   * When omitted, the adapter defaults to application/json for object results.
   */
  responseHeaders?:
    | Record<string, string>
    | ((args: ResponseHeaderArgs) => Record<string, string>);
  /**
   * Additional HTTP response descriptions for the OpenAPI spec (e.g. 404,
   * 409). Carried through to the spec generator so error variants are
   * documented even though the handler communicates them via thrown
   * RouteError subclasses rather than explicit Response objects.
   */
  additionalResponses?: Record<string, { description: string }>;
  /**
   * Per-route request-log control. Routes that opt in can suppress the
   * per-request INFO log line after a confirmed run of successful
   * responses — useful for high-frequency probes like `/v1/health` where
   * the first few responses confirm the route works and every line after
   * that is just noise. Non-success responses (status >= 400) always log.
   */
  logging?: RouteLoggingConfig;
}

/**
 * Logging behavior for a single route. Currently only the success-suppression
 * counter is supported; new knobs (sampling, periodic summary lines) can be
 * added here as separate fields without changing call sites.
 */
export interface RouteLoggingConfig {
  /**
   * After this many successful (status < 400) responses, suppress the
   * per-request INFO log line for further successful responses on the
   * same route (keyed by `operationId`, so all path-param variants
   * share a single counter).
   *
   * Counters are process-local and reset on restart. Warning (4xx) and
   * error (5xx) log lines are always emitted regardless of this setting.
   */
  silenceSuccessAfter?: number;
}
