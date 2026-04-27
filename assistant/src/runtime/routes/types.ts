/**
 * Transport-agnostic route definition served by both the HTTP and IPC servers.
 */

import type { z } from "zod";

export interface RouteDefinition {
  operationId: string;
  endpoint: string;
  method: string;
  handler: (params?: Record<string, unknown>) => unknown | Promise<unknown>;
  policyKey?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  responseBody?: z.ZodType;
}
