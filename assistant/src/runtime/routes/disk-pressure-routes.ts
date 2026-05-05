import { z } from "zod";

import {
  acknowledgeDiskPressureLock,
  DISK_PRESSURE_OVERRIDE_CONFIRMATION,
  getDiskPressureStatus,
  overrideDiskPressureLock,
} from "../../daemon/disk-pressure-guard.js";
import { RouteError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const DiskPressureStatusSchema = z.object({
  enabled: z.boolean(),
  state: z.enum(["disabled", "ok", "critical", "unknown"]),
  locked: z.boolean(),
  acknowledged: z.boolean(),
  overrideActive: z.boolean(),
  effectivelyLocked: z.boolean(),
  lockId: z.string().nullable(),
  usagePercent: z.number().nullable(),
  thresholdPercent: z.number(),
  path: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  blockedCapabilities: z.array(
    z.enum(["agent-turns", "background-work", "remote-ingress"]),
  ),
  error: z.string().nullable(),
});

const DiskPressureActionResponseSchema = z.object({
  status: DiskPressureStatusSchema,
});

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
    policyKey: "disk-pressure/status",
    requirePolicyEnforcement: true,
    summary: "Get disk pressure status",
    description:
      "Return the current disk pressure status snapshot. When safe storage limits are disabled, returns a disabled status.",
    tags: ["disk-pressure"],
    responseBody: DiskPressureActionResponseSchema,
    handler: () => statusResponse(),
  },
  {
    operationId: "acknowledgeDiskPressure",
    endpoint: "disk-pressure/acknowledge",
    method: "POST",
    policyKey: "disk-pressure/acknowledge",
    requirePolicyEnforcement: true,
    summary: "Acknowledge disk pressure",
    description:
      "Acknowledge the current disk pressure lock and enter cleanup mode without overriding assistant protections.",
    tags: ["disk-pressure"],
    responseBody: DiskPressureActionResponseSchema,
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
    policyKey: "disk-pressure/override",
    requirePolicyEnforcement: true,
    summary: "Override disk pressure",
    description: `Override the current disk pressure lock only after confirming "${DISK_PRESSURE_OVERRIDE_CONFIRMATION}".`,
    tags: ["disk-pressure"],
    requestBody: OverrideRequestSchema,
    responseBody: DiskPressureActionResponseSchema,
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
