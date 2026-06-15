import type { z } from "zod";

/**
 * Metadata for a gateway HTTP route, consumed by the OpenAPI generation script.
 *
 * Each route file that wants to appear in the gateway's OpenAPI spec exports
 * a `ROUTES` array of this type. The generation script collects them all and
 * passes the schemas to `createDocument()`.
 */
export interface GatewayRouteDefinition {
  path: string;
  method: "get" | "post" | "put" | "patch" | "delete";
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  responseBody?: z.ZodTypeAny;
  requestBody?: z.ZodTypeAny;
  pathParameters?: Array<{ name: string; description?: string }>;
}
