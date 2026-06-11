/**
 * `tool_use_start` SSE event.
 *
 * Emitted by the daemon's agent loop when a tool invocation begins —
 * carries the tool name, the structured input the model produced, and
 * correlation ids for the conversation, the message, and the tool_use
 * block itself.
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

export const ToolUseStartEventSchema = z.object({
  type: z.literal("tool_use_start"),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  toolUseId: z.string().optional(),
  messageId: z.string().optional(),
  conversationId: z.string().optional(),
  /**
   * Unix ms when the daemon began executing the tool. Lets clients anchor a
   * live elapsed-time counter to the server clock instead of the moment the
   * event was received over SSE. Absent on streams from older daemons that
   * pre-date this field; clients fall back to their own receipt time.
   */
  startedAt: z.number().optional(),
});

export type ToolUseStartEvent = z.infer<typeof ToolUseStartEventSchema>;
