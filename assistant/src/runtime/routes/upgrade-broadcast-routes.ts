/**
 * Upgrade broadcast endpoint — publishes service group update lifecycle
 * events (starting / complete) to all connected SSE clients.
 *
 * This endpoint is unprotected at the daemon level (no policy registration),
 * following the same pattern as health, identity, and debug routes. The
 * gateway is responsible for auth — it requires a valid edge JWT and
 * forwards the request with a service token.
 */

import type {
  ServiceGroupUpdateComplete,
  ServiceGroupUpdateStarting,
} from "../../daemon/message-types/upgrades.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

export function upgradeBroadcastRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "admin/upgrade-broadcast",
      method: "POST",
      handler: async ({ req }) => {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return httpError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        if (!body || typeof body !== "object") {
          return httpError(
            "BAD_REQUEST",
            "Request body must be a JSON object",
            400,
          );
        }

        const { type } = body as { type?: unknown };

        if (type === "starting") {
          const { targetVersion, expectedDowntimeSeconds } = body as {
            targetVersion?: unknown;
            expectedDowntimeSeconds?: unknown;
          };

          if (typeof targetVersion !== "string" || targetVersion.length === 0) {
            return httpError(
              "BAD_REQUEST",
              "targetVersion is required and must be a non-empty string",
              400,
            );
          }

          const downtime =
            expectedDowntimeSeconds === undefined
              ? 60
              : expectedDowntimeSeconds;

          if (
            typeof downtime !== "number" ||
            !isFinite(downtime) ||
            downtime < 0
          ) {
            return httpError(
              "BAD_REQUEST",
              "expectedDowntimeSeconds must be a non-negative number",
              400,
            );
          }

          const message: ServiceGroupUpdateStarting = {
            type: "service_group_update_starting",
            targetVersion,
            expectedDowntimeSeconds: downtime,
          };

          await assistantEventHub.publish(
            buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, message),
          );

          return Response.json({ ok: true });
        }

        if (type === "complete") {
          const { installedVersion, success, rolledBackToVersion } = body as {
            installedVersion?: unknown;
            success?: unknown;
            rolledBackToVersion?: unknown;
          };

          if (
            typeof installedVersion !== "string" ||
            installedVersion.length === 0
          ) {
            return httpError(
              "BAD_REQUEST",
              "installedVersion is required and must be a non-empty string",
              400,
            );
          }

          if (typeof success !== "boolean") {
            return httpError(
              "BAD_REQUEST",
              "success is required and must be a boolean",
              400,
            );
          }

          if (
            rolledBackToVersion !== undefined &&
            (typeof rolledBackToVersion !== "string" ||
              rolledBackToVersion.length === 0)
          ) {
            return httpError(
              "BAD_REQUEST",
              "rolledBackToVersion must be a non-empty string when provided",
              400,
            );
          }

          const message: ServiceGroupUpdateComplete = {
            type: "service_group_update_complete",
            installedVersion,
            success,
            ...(typeof rolledBackToVersion === "string"
              ? { rolledBackToVersion }
              : {}),
          };

          await assistantEventHub.publish(
            buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, message),
          );

          return Response.json({ ok: true });
        }

        return httpError(
          "BAD_REQUEST",
          'type must be "starting" or "complete"',
          400,
        );
      },
    },
  ];
}
