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

export interface RouteHandlerArgs {
  pathParams?: Record<string, string>;
  queryParams?: Record<string, string>;
  body?: Record<string, unknown>;
  rawBody?: Uint8Array;
  headers?: Record<string, string>;
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

export interface RouteDefinition {
  operationId: string;
  endpoint: string;
  method: string;
  handler: (args: RouteHandlerArgs) => unknown | Promise<unknown>;
  policyKey?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  queryParams?: RouteQueryParam[];
  requestBody?: z.ZodType;
  responseBody?: z.ZodType;
  /**
   * HTTP status code for the success response. Defaults to "200".
   * Use "201" for resource creation, "204" for no-content responses.
   * When "204", the HTTP adapter returns an empty body regardless of
   * what the handler returns.
   */
  responseStatus?: string;
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
