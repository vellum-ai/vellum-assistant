/**
 * `background_tool_started` SSE event.
 *
 * Server → client notification that a background bash/host_bash command
 * has started. Carries the background-tool identity (`id`, a `bg-xxxxxxxx`
 * id), the `toolName`, scoping (`conversationId`), the `command` being run,
 * and the `startedAt` timestamp.
 *
 * Canonical wire-contract source. Re-exported to external consumers via
 * `@vellumai/assistant-api` (the `api/index.ts` barrel).
 */

import { z } from "zod";

// No `.strict()`: unknown server-added fields are stripped, not rejected, so a
// future field can't make older clients drop the whole lifecycle event.
export const BackgroundToolStartedEventSchema = z.object({
  type: z.literal("background_tool_started"),
  id: z.string(),
  toolName: z.string(),
  conversationId: z.string(),
  command: z.string(),
  startedAt: z.number(),
});

export type BackgroundToolStartedEvent = z.infer<
  typeof BackgroundToolStartedEventSchema
>;
