/**
 * Wire contract for the disk-pressure REST endpoints
 * (`GET /disk-pressure/status`, `POST /disk-pressure/acknowledge`,
 * `POST /disk-pressure/override`). All three return the current
 * snapshot wrapped as `{ status }`.
 *
 * Reuses the canonical `DiskPressureStatusSchema` defined alongside the
 * `disk_pressure_status_changed` SSE event so the polled REST fetch and
 * the streamed update share a single shape.
 *
 * Canonical wire-contract source. Assistant code imports the types
 * directly from this file via relative paths; external consumers
 * (web client, gateway, evals) import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

import { DiskPressureStatusSchema } from "../events/disk-pressure-status-changed.js";

export const DiskPressureStatusResponseSchema = z.object({
  status: DiskPressureStatusSchema,
});

export type DiskPressureStatusResponse = z.infer<
  typeof DiskPressureStatusResponseSchema
>;
