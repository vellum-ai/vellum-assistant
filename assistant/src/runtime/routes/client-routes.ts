/**
 * Client registry routes — list connected clients and their capabilities.
 */

import { z } from "zod";

import {
  ClientRegistry,
  getClientRegistry,
} from "../client-registry.js";
import type { RouteDefinition } from "./types.js";

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "list_clients",
    endpoint: "clients",
    method: "GET",
    summary: "List connected clients",
    description:
      "Return all connected clients, optionally filtered by capability.",
    tags: ["clients"],
    queryParams: [
      {
        name: "capability",
        type: "string",
        required: false,
        description: "Filter clients by a specific capability.",
      },
    ],
    responseBody: z.object({
      clients: z.array(z.object({}).passthrough()),
    }),
    handler: ({ queryParams }) => {
      const registry = getClientRegistry();
      const capability = queryParams?.capability;

      const entries = capability
        ? registry.listByCapability(
            capability as Parameters<typeof registry.listByCapability>[0],
          )
        : registry.listAll();

      return {
        clients: entries.map((e) => ClientRegistry.toJSON(e)),
      };
    },
  },
];
