/**
 * Routes for querying and overriding the disk-space lock.
 *
 * GET  /v1/disk-lock/status   — current lock state and disk usage
 * POST /v1/disk-lock/override — override the lock (requires confirmation phrase)
 */

import { z } from "zod";

import {
  getDiskLockStatus,
  OVERRIDE_CONFIRMATION_PHRASE,
  overrideDiskLock,
} from "../../daemon/disk-space-guard.js";
import { RouteError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

function handleGetStatus() {
  return getDiskLockStatus();
}

function handleOverride(args: RouteHandlerArgs) {
  const confirmation = (args.body?.confirmation as string | undefined) ?? "";
  const accepted = overrideDiskLock(confirmation);
  if (!accepted) {
    throw new RouteError(
      `Incorrect confirmation phrase. Please type exactly: "${OVERRIDE_CONFIRMATION_PHRASE}"`,
      "INVALID_CONFIRMATION",
      400,
    );
  }
  return getDiskLockStatus();
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getDiskLockStatus",
    endpoint: "disk-lock/status",
    method: "GET",
    handler: handleGetStatus,
    summary: "Disk lock status",
    description:
      "Returns the current disk-space lock state: whether the assistant is locked, whether an override is active, and the current disk usage percentage.",
    tags: ["system"],
    responseBody: z.object({
      locked: z.boolean(),
      overrideActive: z.boolean(),
      effectivelyLocked: z.boolean(),
      diskUsagePercent: z.number().nullable(),
      threshold: z.number(),
    }),
  },
  {
    operationId: "overrideDiskLock",
    endpoint: "disk-lock/override",
    method: "POST",
    handler: handleOverride,
    summary: "Override disk lock",
    description:
      "Manually override the disk-space lock so the assistant can resume unrestricted operation despite high disk usage. Requires a confirmation phrase in the request body. The override persists until disk usage drops below the threshold or the daemon restarts.",
    tags: ["system"],
    requestBody: z.object({
      confirmation: z
        .string()
        .describe(
          "The confirmation phrase the user must type to acknowledge the risk.",
        ),
    }),
    responseBody: z.object({
      locked: z.boolean(),
      overrideActive: z.boolean(),
      effectivelyLocked: z.boolean(),
      diskUsagePercent: z.number().nullable(),
      threshold: z.number(),
    }),
    additionalResponses: {
      "400": { description: "Incorrect confirmation phrase." },
    },
  },
];
