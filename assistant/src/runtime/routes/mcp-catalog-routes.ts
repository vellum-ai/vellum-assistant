import { z } from "zod";

import { getMcpCatalog } from "../../mcp/catalog.js";
import { connectMcpCatalogEntry } from "../../mcp/catalog-connections.js";
import { mcpCatalogEntrySchema } from "../../mcp/catalog-schema.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { parseBody } from "./parse-body.js";
import type { RouteDefinition } from "./types.js";

const connectSchema = z.strictObject({
  catalogId: z.string().min(1),
  serverKey: z.string().min(1),
  definitionDigest: z.string().regex(/^[0-9a-f]{64}$/),
  setupAcknowledged: z.boolean().optional(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "internal_mcp_catalog",
    endpoint: "internal/mcp/catalog",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List known MCP integrations",
    description:
      "Reads bundled standard integration definitions without connecting servers or installing plugins.",
    tags: ["internal"],
    responseBody: z.object({
      supportsConnect: z.literal(true),
      entries: z.array(
        mcpCatalogEntrySchema.omit({ packagePath: true, source: true }).extend({
          definitionDigest: z.string(),
          documents: z.object({
            plugin: z.unknown(),
            mcp: z.unknown().optional(),
          }),
        }),
      ),
    }),
    handler: () => ({ supportsConnect: true, entries: getMcpCatalog() }),
  },
  {
    operationId: "internal_mcp_catalog_connect",
    endpoint: "internal/mcp/catalog/connect",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Create a connection from a known MCP definition",
    description:
      "Reuses a saved catalog connection or creates one with stable identity and separate credentials.",
    tags: ["internal"],
    requestBody: connectSchema,
    responseBody: z.object({ serverId: z.string(), created: z.boolean() }),
    handler: ({ body }) =>
      connectMcpCatalogEntry(parseBody(connectSchema, body)),
  },
];
