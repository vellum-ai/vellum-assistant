/**
 * `background_tool_completed` SSE event.
 *
 * Server → client notification that a background bash/host_bash command
 * has finished. Carries the background-tool identity (`id`), scoping
 * (`conversationId`), the terminal `status`, the optional `exitCode` and
 * captured `output`, and the `completedAt` timestamp.
 *
 * Canonical wire-contract source. Re-exported to external consumers via
 * `@vellumai/assistant-api` (the `api/index.ts` barrel).
 */

import { z } from "zod";

// No `.strict()`: unknown server-added fields are stripped, not rejected, so a
// future field can't make older clients drop the whole lifecycle event.
export const BackgroundToolCompletedEventSchema = z.object({
  type: z.literal("background_tool_completed"),
  id: z.string(),
  conversationId: z.string(),
  status: z.enum(["completed", "failed", "cancelled"]),
  exitCode: z.number().nullable().optional(),
  output: z.string().optional(),
  completedAt: z.number(),
});

export type BackgroundToolCompletedEvent = z.infer<
  typeof BackgroundToolCompletedEventSchema
>;
