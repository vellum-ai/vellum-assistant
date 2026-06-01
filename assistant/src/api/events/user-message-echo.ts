/**
 * `user_message_echo` SSE event.
 *
 * Emitted when a user message is persisted to a conversation — direct
 * sends, slash/canned/compaction turns, and synthetic surface-action
 * prompts. Carries the user's outbound `text` so clients that did not
 * originate the send (passive viewers, other devices) can render the
 * user turn, and so the originating client can dedupe its optimistic
 * row against `messageId`/`clientMessageId`.
 *
 * `messageId` is absent for synthetic echoes where no distinct user row
 * is persisted (e.g. surface-action prompts). `clientMessageId` is the
 * client-generated correlation nonce from the HTTP POST body, echoed
 * back so the originating client can dedupe even if the echo beats the
 * 202 response. `requestId` correlates with `message_queued` /
 * `message_dequeued` for the same turn.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const UserMessageEchoEventSchema = z
  .object({
    type: z.literal("user_message_echo"),
    text: z.string(),
    conversationId: z.string().optional(),
    messageId: z.string().optional(),
    requestId: z.string().optional(),
    clientMessageId: z.string().optional(),
  })
  .strict();

export type UserMessageEchoEvent = z.infer<typeof UserMessageEchoEventSchema>;
