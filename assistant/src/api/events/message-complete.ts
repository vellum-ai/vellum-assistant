/**
 * `message_complete` SSE event.
 *
 * Marks the end of an assistant turn — emitted once per turn after the
 * final `assistant_text_delta` (or as the sole turn event for canned
 * one-shot messages, recording-handler echoes, slash-command outputs,
 * and aux notifier injections that don't stream text). Clients gate
 * task-completion side effects on this event.
 *
 * `messageId` is the database row id of the completed assistant turn;
 * shared with the `assistant_text_delta` chunks that streamed it. May
 * be absent on synthetic completions that don't bind to a persisted
 * row.
 *
 * `source` distinguishes a real main-turn completion from auxiliary
 * notifier injections (call transcripts, call summaries, watch
 * notifier outputs). Clients gate the task-complete sound and similar
 * side effects on `source !== "aux"`. Absent is treated as `"main"`
 * for backwards compatibility.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

import { AssistantOutboundAttachmentSchema } from "./assistant-outbound-attachment.js";

export const MessageCompleteEventSchema = z.object({
  type: z.literal("message_complete"),
  messageId: z.string().optional(),
  conversationId: z.string().optional(),
  source: z.enum(["main", "aux"]).optional(),
  attachments: z.array(AssistantOutboundAttachmentSchema).optional(),
  /** Soft warnings produced while resolving attachments (e.g. format
   *  conversions, size truncations). Display-only — not blocking. */
  attachmentWarnings: z.array(z.string()).optional(),
});

export type MessageCompleteEvent = z.infer<typeof MessageCompleteEventSchema>;
