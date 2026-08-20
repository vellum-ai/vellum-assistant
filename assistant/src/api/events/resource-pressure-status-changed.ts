/**
 * `resource_pressure_status_changed` SSE event.
 *
 * Global broadcast pushed when the daemon's resource-pressure snapshot
 * changes. Mirrors the REST `GET /resource-pressure/status` shape so the
 * client's monitor can apply stream updates and polled fetches through
 * the same code path. Carries no `conversationId`: it is workspace-wide.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ResourcePressureStateSchema = z.enum([
  "disabled",
  "ok",
  "elevated",
  "unknown",
]);

export type ResourcePressureState = z.infer<typeof ResourcePressureStateSchema>;

export const ResourcePressureStatusSchema = z.object({
  enabled: z.boolean(),
  state: ResourcePressureStateSchema,
  /** Latest CPU sample as a percent of the CPU allocation. */
  cpuPercent: z.number().nullable(),
  /** Working set as a percent of the memory limit. */
  memoryPercent: z.number().nullable(),
  /** Whether the CPU signal is holding the `elevated` state. */
  cpuElevated: z.boolean(),
  /** Whether the memory signal is holding the `elevated` state. */
  memoryElevated: z.boolean(),
  cpuThresholdPercent: z.number(),
  memoryThresholdPercent: z.number(),
  lastCheckedAt: z.string().nullable(),
  error: z.string().nullable(),
});

export type ResourcePressureStatus = z.infer<
  typeof ResourcePressureStatusSchema
>;

export const ResourcePressureStatusChangedEventSchema = z.object({
  type: z.literal("resource_pressure_status_changed"),
  status: ResourcePressureStatusSchema,
});

export type ResourcePressureStatusChangedEvent = z.infer<
  typeof ResourcePressureStatusChangedEventSchema
>;
