/**
 * Client registry routes — list connected clients and their capabilities.
 *
 * Queries the assistant event hub's client subscribers rather than a
 * separate registry. Clients register as hub subscribers via SSE /events.
 */

import { z } from "zod";

import type { HostProxyCapability } from "../../channels/types.js";
import { isHttpAuthDisabled } from "../../config/env.js";
import { listClientConnectionHistory } from "../../persistence/client-connection-events-store.js";
import { datesToISO } from "../../util/json.js";
import { getLogger } from "../../util/logger.js";
import {
  assistantEventHub,
  DESKTOP_PRESENCE_STATES,
} from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  isClientDegraded,
} from "../client-health.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import { parseBody } from "./parse-body.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("client-routes");

/**
 * Body of `POST /v1/clients/presence`, declared as the route's `requestBody`
 * and parsed by the handler, so the OpenAPI contract and the runtime check are
 * one schema rather than two hand-kept copies.
 */
const PresenceBodySchema = z.object({
  state: z
    .enum(DESKTOP_PRESENCE_STATES)
    .describe("Reported desktop presence state."),
});

/**
 * Body of `POST /v1/clients/web-presence`, declared as the route's
 * `requestBody` and parsed by the handler, so the OpenAPI contract and the
 * runtime check are one schema rather than two hand-kept copies.
 */
const WebPresenceBodySchema = z.object({
  visible: z
    .boolean()
    .describe("Whether the reporting tab is currently visible."),
  focusedConversationId: z
    .string()
    .nullable()
    .describe(
      "The conversation currently focused (chat composer on screen) in the tab, or null.",
    ),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "list_clients",
    endpoint: "clients",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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

      const now = new Date();
      return {
        clients: filtered.map((c) =>
          datesToISO({
            clientId: c.clientId,
            interfaceId: c.interfaceId,
            capabilities: c.capabilities,
            machineName: c.machineName,
            clientVersion: c.clientVersion,
            sseWatchdog: c.sseWatchdog,
            connectedAt: c.connectedAt,
            lastActiveAt: c.lastActiveAt,
            degraded: isClientDegraded(
              c.lastActiveAt,
              now,
              DEFAULT_HEARTBEAT_INTERVAL_MS,
            ),
          }),
        ),
      };
    },
  },
  {
    operationId: "disconnect_client",
    endpoint: "clients/disconnect",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
  {
    operationId: "list_client_history",
    endpoint: "clients/history",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List client connection history",
    description:
      "Return persisted client subscribe/dispose events and coalesced sessions. Reconnects shorter than 60 seconds are flaps, not outages.",
    tags: ["clients"],
    queryParams: [
      {
        name: "clientId",
        type: "string",
        required: false,
        description: "Restrict history to one client UUID.",
      },
      {
        name: "interfaceId",
        type: "string",
        required: false,
        description: "Restrict history to one interface (e.g. chrome-extension).",
      },
      {
        name: "since",
        type: "string",
        required: false,
        description:
          "ISO-8601 or epoch-ms lower bound. Sessions already open at this time are included.",
      },
      {
        name: "limit",
        type: "string",
        required: false,
        description: "Max coalesced sessions to return (1-500, default 50).",
      },
    ],
    responseBody: z.object({
      sessions: z.array(z.object({}).passthrough()),
      events: z.array(z.object({}).passthrough()),
    }),
    handler: ({ queryParams, headers }) => {
      const since = parseHistorySince(queryParams?.since);
      const limit = parseHistoryLimit(queryParams?.limit);
      const callerPrincipalId = headers?.["x-vellum-actor-principal-id"];
      const history = listClientConnectionHistory({
        clientId: queryParams?.clientId?.trim() || undefined,
        interfaceId: queryParams?.interfaceId?.trim() || undefined,
        actorPrincipalId: isHttpAuthDisabled()
          ? undefined
          : callerPrincipalId || "__none__",
        since,
        limit,
      });

      return {
        sessions: history.sessions.map((session) => ({
          ...session,
          startedAt: new Date(session.startedAt).toISOString(),
          endedAt:
            session.endedAt == null
              ? null
              : new Date(session.endedAt).toISOString(),
        })),
        events: history.events.map((event) => ({
          ...event,
          occurredAt: new Date(event.occurredAt).toISOString(),
        })),
      };
    },
  },
  {
    operationId: "report_client_presence",
    endpoint: "clients/presence",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Report desktop presence",
    description:
      "Record the desktop presence state reported by the client identified by the X-Vellum-Client-Id header.",
    tags: ["clients"],
    requestBody: PresenceBodySchema,
    responseBody: z.object({
      recorded: z
        .boolean()
        .describe("Whether a connected client matched the reporting clientId."),
    }),
    handler: ({ body, headers }) => {
      const clientId = headers?.["x-vellum-client-id"]?.trim();
      if (!clientId) {
        throw new BadRequestError(
          "x-vellum-client-id header is required to report presence.",
        );
      }
      const { state } = parseBody(PresenceBodySchema, body);

      // Resolving the client first separates "nobody is listening" from
      // "somebody else owns this", so only the second one is worth a warn.
      const client = assistantEventHub.getClientById(clientId);
      if (!client) {
        // Debug, not warn: a report racing an SSE reconnect matches nothing,
        // and a reconnect storm would otherwise emit a warn per client every
        // 30 seconds for a benign race. Not a 404 either, for the same reason.
        log.debug(
          { op: "report_client_presence", state },
          "Presence report matched no connected client",
        );
        return { recorded: false };
      }

      // Only the actor that opened the target client's SSE stream may report
      // its presence, so a caller who learns another user's clientId cannot
      // spoof that desktop. Clients with no stored `actorPrincipalId` (legacy
      // SSE subscribers, service-gateway tokens) never match: fail-closed, the
      // same posture as the listing filter above. Dev-bypass mode
      // (DISABLE_HTTP_AUTH=true) skips the check for platform-managed
      // deployments where the platform handles auth.
      if (!isHttpAuthDisabled()) {
        const callerPrincipalId = headers?.["x-vellum-actor-principal-id"];
        const ownerPrincipalId = client.actorPrincipalId;
        if (
          ownerPrincipalId === undefined ||
          ownerPrincipalId !== callerPrincipalId
        ) {
          // Warn, not debug: the client is connected, so a mismatch means the
          // gateway stopped forwarding the actor header, a scope profile
          // shifted, or a caller is probing someone else's client. Without this
          // line presence gating dies silently and every suppressed push
          // quietly resumes. Client and principal ids stay out of the entry so
          // the log cannot be used to enumerate them.
          log.warn(
            {
              op: "report_client_presence",
              hasStoredOwner: ownerPrincipalId !== undefined,
              hasCallerPrincipal: callerPrincipalId !== undefined,
              targetInterfaceId: client.interfaceId,
            },
            "Rejecting presence report from a caller that does not own the client",
          );
          // Answering like "no match" keeps the reply from probing client ids.
          return { recorded: false };
        }
      }

      // The lookup ran in this same synchronous handler, so the write lands on
      // the entry it resolved.
      assistantEventHub.setClientPresence(clientId, state);

      // Records which state a client actually reported. Nothing else persists
      // it, so this is the only evidence for why a machine did or did not
      // count as attended. Only `macos` clients gate pushes, hence the
      // interface id.
      log.debug(
        {
          op: "report_client_presence",
          state,
          interfaceId: client.interfaceId,
        },
        "Recorded desktop presence",
      );
      return { recorded: true };
    },
  },
  {
    operationId: "report_web_presence",
    endpoint: "clients/web-presence",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Report web tab visibility and focused conversation",
    description:
      "Record the visibility and focused conversation reported by the web client identified by the X-Vellum-Client-Id header.",
    tags: ["clients"],
    requestBody: WebPresenceBodySchema,
    responseBody: z.object({
      recorded: z
        .boolean()
        .describe("Whether a connected client matched the reporting clientId."),
    }),
    handler: ({ body, headers }) => {
      const clientId = headers?.["x-vellum-client-id"]?.trim();
      if (!clientId) {
        throw new BadRequestError(
          "x-vellum-client-id header is required to report presence.",
        );
      }
      const { visible, focusedConversationId } = parseBody(
        WebPresenceBodySchema,
        body,
      );

      // Resolving the client first separates "nobody is listening" from
      // "somebody else owns this", so only the second one is worth a warn.
      const client = assistantEventHub.getClientById(clientId);
      if (!client) {
        // Debug, not warn: a report racing an SSE reconnect matches nothing,
        // and a reconnect storm would otherwise emit a warn per client for a
        // benign race. Not a 404 either, for the same reason.
        log.debug(
          { op: "report_web_presence" },
          "Web presence report matched no connected client",
        );
        return { recorded: false };
      }

      // Only the actor that opened the target client's SSE stream may report
      // its presence, so a caller who learns another user's clientId cannot
      // spoof that tab. Clients with no stored `actorPrincipalId` (legacy SSE
      // subscribers, service-gateway tokens) never match: fail-closed, the
      // same posture as `report_client_presence`. Dev-bypass mode
      // (DISABLE_HTTP_AUTH=true) skips the check for platform-managed
      // deployments where the platform handles auth.
      if (!isHttpAuthDisabled()) {
        const callerPrincipalId = headers?.["x-vellum-actor-principal-id"];
        const ownerPrincipalId = client.actorPrincipalId;
        if (
          ownerPrincipalId === undefined ||
          ownerPrincipalId !== callerPrincipalId
        ) {
          // Warn, not debug: the client is connected, so a mismatch means the
          // gateway stopped forwarding the actor header, a scope profile
          // shifted, or a caller is probing someone else's client. Without
          // this line presence gating dies silently and every suppressed
          // push quietly resumes. Client and principal ids stay out of the
          // entry so the log cannot be used to enumerate them.
          log.warn(
            {
              op: "report_web_presence",
              hasStoredOwner: ownerPrincipalId !== undefined,
              hasCallerPrincipal: callerPrincipalId !== undefined,
              targetInterfaceId: client.interfaceId,
            },
            "Rejecting web presence report from a caller that does not own the client",
          );
          // Answering like "no match" keeps the reply from probing client ids.
          return { recorded: false };
        }
      }

      // The lookup ran in this same synchronous handler, so the write lands on
      // the entry it resolved.
      assistantEventHub.setClientWebPresence(clientId, {
        visible,
        focusedConversationId,
      });

      log.debug(
        {
          op: "report_web_presence",
          visible,
          interfaceId: client.interfaceId,
        },
        "Recorded web presence",
      );
      return { recorded: true };
    },
  },
];

function parseHistorySince(raw: string | undefined): number | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const epoch = Number(trimmed);
    if (!Number.isFinite(epoch) || epoch < 0) {
      throw new BadRequestError("since must be a non-negative epoch-ms value");
    }
    return epoch;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new BadRequestError(
      "since must be an ISO-8601 timestamp or epoch milliseconds",
    );
  }
  return parsed;
}

function parseHistoryLimit(raw: string | undefined): number | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestError("limit must be a positive integer");
  }
  return parsed;
}
