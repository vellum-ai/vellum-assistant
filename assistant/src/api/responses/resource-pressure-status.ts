/**
 * Wire contract for the resource-pressure REST endpoint
 * (`GET /resource-pressure/status`). Returns the current snapshot
 * wrapped as `{ status }`.
 *
 * Reuses the canonical `ResourcePressureStatusSchema` defined alongside
 * the `resource_pressure_status_changed` SSE event so the polled REST
 * fetch and the streamed update share a single shape.
 *
 * Canonical wire-contract source. Assistant code imports the types
 * directly from this file via relative paths; external consumers
 * (web client, gateway, evals) import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

import { ResourcePressureStatusSchema } from "../events/resource-pressure-status-changed.js";

export const ResourcePressureStatusResponseSchema = z.object({
  status: ResourcePressureStatusSchema,
});

export type ResourcePressureStatusResponse = z.infer<
  typeof ResourcePressureStatusResponseSchema
>;
