/**
 * Upgrade broadcast endpoint — publishes service group update lifecycle
 * events (starting / progress / complete) to all connected SSE clients.
 */

import { z } from "zod";

import type {
  ServiceGroupUpdateComplete,
  ServiceGroupUpdateProgress,
  ServiceGroupUpdateStarting,
} from "../../daemon/message-types/upgrades.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

async function handleUpgradeBroadcast({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body must be a JSON object");
  }

  const { type } = body as { type?: unknown };

  if (type === "starting") {
    const { targetVersion, expectedDowntimeSeconds } = body as {
      targetVersion?: unknown;
      expectedDowntimeSeconds?: unknown;
    };

    if (typeof targetVersion !== "string" || targetVersion.length === 0) {
      throw new BadRequestError(
        "targetVersion is required and must be a non-empty string",
      );
    }

    const downtime =
      expectedDowntimeSeconds === undefined ? 60 : expectedDowntimeSeconds;

    if (typeof downtime !== "number" || !isFinite(downtime) || downtime < 0) {
      throw new BadRequestError(
        "expectedDowntimeSeconds must be a non-negative number",
      );
    }

    const message: ServiceGroupUpdateStarting = {
      type: "service_group_update_starting",
      targetVersion,
      expectedDowntimeSeconds: downtime,
    };

    await assistantEventHub.publish(buildAssistantEvent(message));

    return { ok: true };
  }

  if (type === "progress") {
    const { statusMessage } = body as { statusMessage?: unknown };

    if (typeof statusMessage !== "string" || statusMessage.length === 0) {
      throw new BadRequestError(
        "statusMessage is required and must be a non-empty string",
      );
    }

    const message: ServiceGroupUpdateProgress = {
      type: "service_group_update_progress",
      statusMessage,
    };

    await assistantEventHub.publish(buildAssistantEvent(message));

    return { ok: true };
  }

  if (type === "complete") {
    const { installedVersion, success, rolledBackToVersion } = body as {
      installedVersion?: unknown;
      success?: unknown;
      rolledBackToVersion?: unknown;
    };

    if (typeof installedVersion !== "string" || installedVersion.length === 0) {
      throw new BadRequestError(
        "installedVersion is required and must be a non-empty string",
      );
    }

    if (typeof success !== "boolean") {
      throw new BadRequestError("success is required and must be a boolean");
    }

    if (
      rolledBackToVersion !== undefined &&
      (typeof rolledBackToVersion !== "string" ||
        rolledBackToVersion.length === 0)
    ) {
      throw new BadRequestError(
        "rolledBackToVersion must be a non-empty string when provided",
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

    await assistantEventHub.publish(buildAssistantEvent(message));

    return { ok: true };
  }

  throw new BadRequestError(
    'type must be "starting", "progress", or "complete"',
  );
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "upgrade_broadcast",
    endpoint: "admin/upgrade-broadcast",
    method: "POST",
    summary: "Broadcast upgrade lifecycle event",
    description:
      "Publish a service group update lifecycle event (starting, progress, or complete) to all connected SSE clients.",
    tags: ["admin"],
    requestBody: z.object({
      type: z
        .string()
        .describe('Event type: "starting", "progress", or "complete"'),
      targetVersion: z
        .string()
        .describe("Target version (required for starting)")
        .optional(),
      expectedDowntimeSeconds: z
        .number()
        .describe("Expected downtime in seconds (starting, default 60)")
        .optional(),
      statusMessage: z
        .string()
        .describe("Status message (required for progress)")
        .optional(),
      installedVersion: z
        .string()
        .describe("Installed version (required for complete)")
        .optional(),
      success: z
        .boolean()
        .describe("Whether upgrade succeeded (required for complete)")
        .optional(),
      rolledBackToVersion: z
        .string()
        .describe("Version rolled back to, if any (complete)")
        .optional(),
    }),
    responseBody: z.object({
      ok: z.boolean(),
    }),
    handler: handleUpgradeBroadcast,
  },
];
