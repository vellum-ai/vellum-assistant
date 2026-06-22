/**
 * `tool_output_chunk` SSE event.
 *
 * Streamed by the daemon's agent loop while a tool runs, carrying
 * incremental output (e.g. a bash command's stdout). The `subType` and
 * `subTool*` fields describe nested sub-tool activity for tools that
 * themselves orchestrate other tools, so clients can render sub-steps
 * within the parent tool's output.
 *
 * `messageId` is the database row id of the assistant message that owns
 * the parent tool_use block; absent on streams produced by older daemons
 * that pre-date the anchor protocol. Same semantics as
 * `AssistantTextDeltaEvent.messageId`.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ToolOutputChunkSubTypeSchema = z.enum([
  "tool_start",
  "tool_complete",
  "status",
]);

export type ToolOutputChunkSubType = z.infer<
  typeof ToolOutputChunkSubTypeSchema
>;

export const ToolOutputChunkEventSchema = z.object({
  type: z.literal("tool_output_chunk"),
  chunk: z.string(),
  conversationId: z.string().optional(),
  toolUseId: z.string().optional(),
  subType: ToolOutputChunkSubTypeSchema.optional(),
  subToolName: z.string().optional(),
  subToolInput: z.string().optional(),
  subToolIsError: z.boolean().optional(),
  subToolId: z.string().optional(),
  messageId: z.string().optional(),
});

export type ToolOutputChunkEvent = z.infer<typeof ToolOutputChunkEventSchema>;
