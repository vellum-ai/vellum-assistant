/**
 * Routes for querying and overriding the disk-space lock.
 *
 * GET  /v1/disk-lock/status   — current lock state and disk usage
 * POST /v1/disk-lock/override — manually override the lock
 */

import { z } from "zod";

import {
  getDiskLockStatus,
  overrideDiskLock,
} from "../../daemon/disk-space-guard.js";
import type { RouteDefinition } from "./types.js";

function handleGetStatus() {
  return getDiskLockStatus();
}

function handleOverride() {
  overrideDiskLock();
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
      "Manually override the disk-space lock so the assistant can continue operating despite high disk usage. The override persists until disk usage drops below the threshold or the daemon restarts.",
    tags: ["system"],
    responseBody: z.object({
      locked: z.boolean(),
      overrideActive: z.boolean(),
      effectivelyLocked: z.boolean(),
      diskUsagePercent: z.number().nullable(),
      threshold: z.number(),
    }),
  },
];
