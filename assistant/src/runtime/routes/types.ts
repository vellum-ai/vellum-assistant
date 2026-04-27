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
  params?: Record<string, unknown>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
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
  queryParams?: RouteQueryParam[];
  requestBody?: z.ZodType;
  responseBody?: z.ZodType;
}
