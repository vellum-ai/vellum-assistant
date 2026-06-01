/**
 * `subagent_spawned` SSE event.
 *
 * Server → client notification that a new subagent has been spawned
 * by the parent conversation. Carries identity (`subagentId`),
 * scoping (`parentConversationId`), human-readable display fields
 * (`label`, `objective`), and optional spawn-context (`isFork`,
 * `parentToolUseId` for tool-use anchoring).
 *
 * NOTE: no `conversationId` field. Subagent lifecycle events route
 * to the parent conversation's SSE stream via the parent's
 * `sendToClient` closure (`parentSendToClient`), not via the
 * conversation-scoped seq stamping path. The parent conversation is
 * identified explicitly by `parentConversationId`.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const SubagentSpawnedEventSchema = z
  .object({
    type: z.literal("subagent_spawned"),
    subagentId: z.string(),
    parentConversationId: z.string(),
    label: z.string(),
    objective: z.string(),
    isFork: z.boolean().optional(),
    /**
     * Tool-use id of the `skill_execute` call that spawned this subagent.
     * Lets the client anchor the inline subagent card to the exact spawn
     * tool call, independent of the (reconcile-volatile) parent message id.
     */
    parentToolUseId: z.string().optional(),
  })
  .strict();

export type SubagentSpawnedEvent = z.infer<typeof SubagentSpawnedEventSchema>;
