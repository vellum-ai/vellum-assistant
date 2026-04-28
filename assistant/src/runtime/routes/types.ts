/**
 * Transport-agnostic route definition served by both the HTTP and IPC servers.
 */

import type { z } from "zod";

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
  ) {}
}

export interface RouteDefinition {
  operationId: string;
  endpoint: string;
  method: string;
  handler: (args: RouteHandlerArgs) => unknown | Promise<unknown>;
  policyKey?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  pathParams?: RoutePathParam[];
  queryParams?: RouteQueryParam[];
  requestBody?: z.ZodType;
  responseBody?: z.ZodType;
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
   * When true, the route requires scope-based policy enforcement that
   * the HTTP server performs via `enforcePolicy()`. The IPC adapter
   * excludes these routes until the gateway implements equivalent
   * scope checking (ATL-315).
   */
  requirePolicyEnforcement?: boolean;
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
}
