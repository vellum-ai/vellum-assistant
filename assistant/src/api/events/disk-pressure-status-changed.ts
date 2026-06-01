/**
 * `disk_pressure_status_changed` SSE event.
 *
 * Global broadcast pushed when the daemon's disk-pressure snapshot
 * changes. Mirrors the REST `GET /disk-pressure` status shape so the
 * client's monitor can apply stream updates and polled fetches through
 * the same code path. Carries no `conversationId` — it is workspace-wide.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const DiskPressureStateSchema = z.enum([
  "disabled",
  "ok",
  "warning",
  "critical",
  "unknown",
]);

export type DiskPressureState = z.infer<typeof DiskPressureStateSchema>;

export const DiskPressureBlockedCapabilitySchema = z.enum([
  "agent-turns",
  "background-work",
  "remote-ingress",
]);

export type DiskPressureBlockedCapability = z.infer<
  typeof DiskPressureBlockedCapabilitySchema
>;

export const DiskPressureStatusSchema = z.object({
  enabled: z.boolean(),
  state: DiskPressureStateSchema,
  locked: z.boolean(),
  acknowledged: z.boolean(),
  overrideActive: z.boolean(),
  effectivelyLocked: z.boolean(),
  lockId: z.string().nullable(),
  usagePercent: z.number().nullable(),
  thresholdPercent: z.number(),
  path: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  blockedCapabilities: z.array(DiskPressureBlockedCapabilitySchema),
  error: z.string().nullable(),
});

export type DiskPressureStatus = z.infer<typeof DiskPressureStatusSchema>;

export const DiskPressureStatusChangedEventSchema = z.object({
  type: z.literal("disk_pressure_status_changed"),
  status: DiskPressureStatusSchema,
});

export type DiskPressureStatusChangedEvent = z.infer<
  typeof DiskPressureStatusChangedEventSchema
>;
