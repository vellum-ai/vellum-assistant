/**
 * Transport-agnostic route definition served by both the HTTP and IPC servers.
 */

import type { z } from "zod";

export interface RouteQueryParam {
  name: string;
  type?: string;
  required?: boolean;
  description?: string;
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
   * Response headers for this route. Can be:
   * - A static map of header name → value
   * - A function that computes headers from path/query params + request headers
   *
   * When omitted, the adapter defaults to application/json for object results.
   */
  responseHeaders?:
    | Record<string, string>
    | ((args: ResponseHeaderArgs) => Record<string, string>);
}
