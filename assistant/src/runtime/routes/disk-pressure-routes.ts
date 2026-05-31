import { z } from "zod";

import { DiskPressureStatusResponseSchema } from "../../api/responses/disk-pressure-status.js";
import {
  acknowledgeDiskPressureLock,
  DISK_PRESSURE_OVERRIDE_CONFIRMATION,
  getDiskPressureStatus,
  overrideDiskPressureLock,
} from "../../daemon/disk-pressure-guard.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { RouteError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const OverrideRequestSchema = z.object({
  confirmation: z.string(),
});

function statusResponse() {
  return { status: getDiskPressureStatus() };
}

function transitionErrorCode(
  reason: "not_locked" | "already_acknowledged" | "already_overridden",
): string {
  if (reason === "not_locked") return "NOT_LOCKED";
  if (reason === "already_acknowledged") return "ALREADY_ACKNOWLEDGED";
  return "ALREADY_OVERRIDDEN";
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getDiskPressureStatus",
    endpoint: "disk-pressure/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get disk pressure status",
    description:
      "Return the current disk pressure status snapshot. When safe storage limits are disabled, returns a disabled status.",
    tags: ["disk-pressure"],
    responseBody: DiskPressureStatusResponseSchema,
    handler: () => statusResponse(),
  },
  {
    operationId: "acknowledgeDiskPressure",
    endpoint: "disk-pressure/acknowledge",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Acknowledge disk pressure",
    description:
      "Acknowledge the current disk pressure lock and enter cleanup mode without overriding assistant protections.",
    tags: ["disk-pressure"],
    responseBody: DiskPressureStatusResponseSchema,
    additionalResponses: {
      "409": { description: "No active lock or lock already acknowledged." },
    },
    handler: () => {
      const result = acknowledgeDiskPressureLock();
      if (result.ok) return { status: result.status };
      if (result.reason === "invalid_confirmation") {
        throw new RouteError(result.message, "INVALID_CONFIRMATION", 400);
      }
      throw new RouteError(
        result.message,
        transitionErrorCode(result.reason),
        409,
      );
    },
  },
  {
    operationId: "overrideDiskPressure",
    endpoint: "disk-pressure/override",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Override disk pressure",
    description: `Override the current disk pressure lock only after confirming "${DISK_PRESSURE_OVERRIDE_CONFIRMATION}".`,
    tags: ["disk-pressure"],
    requestBody: OverrideRequestSchema,
    responseBody: DiskPressureStatusResponseSchema,
    additionalResponses: {
      "400": { description: "Confirmation phrase is invalid." },
      "409": { description: "No active lock or lock already overridden." },
    },
    handler: ({ body }) => {
      const parsed = OverrideRequestSchema.safeParse(body);
      const confirmation = parsed.success ? parsed.data.confirmation : "";
      const result = overrideDiskPressureLock(confirmation);
      if (result.ok) return { status: result.status };
      if (result.reason === "invalid_confirmation") {
        throw new RouteError(result.message, "INVALID_CONFIRMATION", 400);
      }
      throw new RouteError(
        result.message,
        transitionErrorCode(result.reason),
        409,
      );
    },
  },
];
