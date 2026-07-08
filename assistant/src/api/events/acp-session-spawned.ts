/**
 * `acp_session_spawned` SSE event.
 *
 * Server → client notification that a new ACP (Agent Client Protocol)
 * session has been spawned by the parent conversation. Carries the
 * session identity (`acpSessionId`), the `agent` driving it, scoping
 * (`parentConversationId`), and optional spawn-context: `parentToolUseId`
 * anchors the inline card to the `acp_spawn` tool-use block, and `task`
 * carries the objective text.
 *
 * Canonical wire-contract source. Re-exported to external consumers via
 * `@vellumai/assistant-api` (the `api/index.ts` barrel).
 */

import { z } from "zod";

export const AcpSessionSpawnedEventSchema = z
  .object({
    type: z.literal("acp_session_spawned"),
    acpSessionId: z.string(),
    agent: z.string(),
    parentConversationId: z.string(),
    /** Tool-use id of the `acp_spawn` call that spawned this session. */
    parentToolUseId: z.string().optional(),
    /** Objective text for the spawned session. */
    task: z.string().optional(),
  })
  .strict();

export type AcpSessionSpawnedEvent = z.infer<
  typeof AcpSessionSpawnedEventSchema
>;
