/**
 * `tool_use_preview_start` SSE event.
 *
 * Emitted by the daemon's agent loop the moment a tool_use block is
 * recognized in the model stream, before its input has finished
 * streaming. Clients use it to render a tool affordance optimistically;
 * the structured input arrives later via `tool_input_delta` and the
 * invocation proper via `tool_use_start`.
 *
 * `messageId` is the database row id of the assistant message that owns
 * this tool_use block; absent on streams produced by older daemons that
 * pre-date the anchor protocol. Same semantics as
 * `AssistantTextDeltaEvent.messageId`.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ToolUsePreviewStartEventSchema = z.object({
  type: z.literal("tool_use_preview_start"),
  toolUseId: z.string(),
  toolName: z.string(),
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
});

export type ToolUsePreviewStartEvent = z.infer<
  typeof ToolUsePreviewStartEventSchema
>;
