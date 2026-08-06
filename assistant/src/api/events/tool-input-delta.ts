/**
 * `tool_input_delta` SSE event.
 *
 * Server → client streaming chunk of a tool call's input as it is
 * generated, so clients can render tool arguments incrementally.
 * `toolUseId` correlates the chunk to its tool-use block and
 * `messageId` to the owning assistant message.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ToolInputDeltaEventSchema = z.object({
  type: z.literal("tool_input_delta"),
  toolName: z.string(),
  content: z.string(),
  conversationId: z.string().optional(),
  /** The tool_use block ID for client-side correlation. */
  toolUseId: z.string().optional(),
  /**
   * Database ID of the assistant message that owns this tool_use block.
   * Same semantics as `AssistantTextDeltaEvent.messageId`.
   */
  messageId: z.string().optional(),
});

export type ToolInputDeltaEvent = z.infer<typeof ToolInputDeltaEventSchema>;
