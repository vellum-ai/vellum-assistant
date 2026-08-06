/**
 * `memory_status` SSE event.
 *
 * Server → client gauge reporting whether the memory subsystem is
 * enabled and healthy for the current turn. When `degraded` is true,
 * `degradation` / `reason` explain why semantic recall is unavailable
 * so clients can surface a subtle notice. Shares the degradation shape
 * with `memory_recalled`.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

import { MemoryRecalledDegradationSchema } from "./memory-recalled.js";

export const MemoryStatusEventSchema = z.object({
  type: z.literal("memory_status"),
  enabled: z.boolean(),
  degraded: z.boolean(),
  degradation: MemoryRecalledDegradationSchema.optional(),
  reason: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
});

export type MemoryStatusEvent = z.infer<typeof MemoryStatusEventSchema>;
