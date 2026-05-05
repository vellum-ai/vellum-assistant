/**
 * Client registry routes — list connected clients and their capabilities.
 *
 * Queries the assistant event hub's client subscribers rather than a
 * separate registry. Clients register as hub subscribers via SSE /events.
 */

import { z } from "zod";

import type { HostProxyCapability } from "../../channels/types.js";
import { isHttpAuthDisabled } from "../../config/env.js";
import { datesToISO } from "../../util/json.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { NotFoundError } from "./errors.js";
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
    handler: ({ queryParams, headers }) => {
      const capability = queryParams?.capability as
        | HostProxyCapability
        | undefined;

      const clients = capability
        ? assistantEventHub.listClientsByCapability(capability)
        : assistantEventHub.listClients();

      // Defense-in-depth: filter the listing to clients owned by the calling
      // actor so users cannot enumerate other users' connected client IDs.
      // Clients with no stored `actorPrincipalId` (legacy SSE subscribers from
      // before host-proxy-same-user, service-gateway tokens) are filtered out
      // — fail-closed is the right default for this security boundary.
      // Dev-bypass mode (DISABLE_HTTP_AUTH=true, mirroring
      // require-bound-guardian.ts) preserves the previous "return all" behavior
      // for platform-managed deployments where the platform handles auth.
      const callerPrincipalId = headers?.["x-vellum-actor-principal-id"];
      const filtered = isHttpAuthDisabled()
        ? clients
        : clients.filter(
            (c) =>
              c.actorPrincipalId !== undefined &&
              c.actorPrincipalId === callerPrincipalId,
          );

      return {
        clients: filtered.map((c) =>
          datesToISO({
            clientId: c.clientId,
            interfaceId: c.interfaceId,
            capabilities: c.capabilities,
            machineName: c.machineName,
            connectedAt: c.connectedAt,
            lastActiveAt: c.lastActiveAt,
          }),
        ),
      };
    },
  },
  {
    operationId: "disconnect_client",
    endpoint: "clients/disconnect",
    method: "POST",
    summary: "Force-disconnect a client",
    description:
      "Dispose all hub subscribers for the given clientId, forcibly closing their SSE streams.",
    tags: ["clients"],
    requestBody: z.object({
      clientId: z.string().describe("The client UUID to disconnect."),
    }),
    responseBody: z.object({
      disconnected: z.number().describe("Number of disposed subscribers."),
    }),
    handler: ({ body }) => {
      const { clientId } = body as { clientId: string };
      const count = assistantEventHub.disposeClient(clientId);
      if (count === 0) {
        throw new NotFoundError(`No connected client with id "${clientId}"`);
      }
      return { disconnected: count };
    },
  },
];
