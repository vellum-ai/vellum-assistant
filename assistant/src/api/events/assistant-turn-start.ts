/**
 * `assistant_turn_start` SSE event.
 *
 * Marks the start of an assistant turn — emitted once by the daemon
 * *before* any `assistant_text_delta`, `tool_use_start`, or
 * `assistant_thinking_delta` event for that turn. The `messageId` is the
 * pre-allocated database row id (see `reserveMessage` in
 * `assistant/src/memory/conversation-crud.ts`) that subsequent streaming
 * events stamp on their `messageId` field. Clients use this id to
 * anchor a UI bubble at turn-start instead of waiting for
 * `message_complete`.
 *
 * Types-only addition at introduction — no daemon emit sites yet. The
 * agent loop will adopt pre-allocation in a follow-up.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const AssistantTurnStartEventSchema = z.object({
  type: z.literal("assistant_turn_start"),
  messageId: z.string(),
  conversationId: z.string().optional(),
});

export type AssistantTurnStartEvent = z.infer<
  typeof AssistantTurnStartEventSchema
>;
