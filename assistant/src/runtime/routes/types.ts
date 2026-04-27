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
  body?: Record<string, unknown> | Uint8Array;
  headers?: Record<string, string>;
}

/**
 * Wrapper for non-JSON handler responses (HTML, binary, etc.).
 * When a handler returns a RouteResponse, adapters use `body` as the raw
 * payload and forward `headers` (Content-Type, Content-Disposition, etc.)
 * to the transport layer.
 */
export interface RouteResponse {
  body: Uint8Array | string;
  headers?: Record<string, string>;
}

export function isRouteResponse(val: unknown): val is RouteResponse {
  if (val == null || typeof val !== "object" || !("body" in val)) return false;
  const { body } = val as { body: unknown };
  return body instanceof Uint8Array || typeof body === "string";
}

export interface RouteDefinition {
  operationId: string;
  endpoint: string;
  method: string;
  handler: (
    args: RouteHandlerArgs,
  ) => unknown | RouteResponse | Promise<unknown | RouteResponse>;
  policyKey?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  queryParams?: RouteQueryParam[];
  requestBody?: z.ZodType;
  responseBody?: z.ZodType;
}
