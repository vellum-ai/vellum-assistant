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
  /**
   * Unix ms when the daemon recognized this tool_use block in the model stream
   * — the first byte of the tool call, before its input has finished streaming.
   * Clients anchor the user-perceived latency timer to this server clock so the
   * elapsed counter captures the gap until the tool actually executes (which can
   * be many seconds while a large input streams). The tool's own execution time
   * is measured separately from `tool_use_start.startedAt`. Absent on streams
   * from older daemons that pre-date this field; clients fall back to the
   * execution `startedAt`.
   */
  previewStartedAt: z.number().optional(),
});

export type ToolUsePreviewStartEvent = z.infer<
  typeof ToolUsePreviewStartEventSchema
>;
