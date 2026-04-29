/**
 * Client registry routes — list connected clients and their capabilities.
 *
 * Queries the assistant event hub's client subscribers rather than a
 * separate registry. Clients register as hub subscribers via SSE /events.
 */

import { z } from "zod";

import type { HostProxyCapability } from "../../channels/types.js";
import { datesToISO } from "../../util/json.js";
import { assistantEventHub } from "../assistant-event-hub.js";
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
      const capability = queryParams?.capability as
        | HostProxyCapability
        | undefined;

      const clients = capability
        ? assistantEventHub.listClientsByCapability(capability)
        : assistantEventHub.listClients();

      return {
        clients: clients.map((c) =>
          datesToISO({
            clientId: c.clientId,
            interfaceId: c.interfaceId,
            capabilities: c.capabilities,
            connectedAt: c.connectedAt,
            lastActiveAt: c.lastActiveAt,
          }),
        ),
      };
    },
  },
];
