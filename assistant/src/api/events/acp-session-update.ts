/**
 * `acp_session_update` SSE event.
 *
 * Server → client incremental update from a running ACP session.
 * `updateType` discriminates the payload (message/thought/user chunks,
 * tool-call lifecycle, plan). Content and tool-call fields are optional
 * since they apply only to the relevant `updateType`s. `messageId` and
 * `seq` let clients correlate and order chunks within a session.
 *
 * Canonical wire-contract source. Re-exported to external consumers via
 * `@vellumai/assistant-api` (the `api/index.ts` barrel).
 */

import { z } from "zod";

export const AcpSessionUpdateTypeSchema = z.enum([
  "agent_message_chunk",
  "agent_thought_chunk",
  "user_message_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

export type AcpSessionUpdateType = z.infer<typeof AcpSessionUpdateTypeSchema>;

export const AcpSessionUpdateEventSchema = z
  .object({
    type: z.literal("acp_session_update"),
    acpSessionId: z.string(),
    updateType: AcpSessionUpdateTypeSchema,
    content: z.string().optional(),
    toolCallId: z.string().optional(),
    toolTitle: z.string().optional(),
    toolKind: z.string().optional(),
    toolStatus: z.string().optional(),
    /** Optional raw tool input/output (ACP rawInput/rawOutput); apply to tool_call/tool_call_update. */
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
    /** Files touched by this tool call (for the file-diff affordance). */
    locations: z
      .array(z.object({ path: z.string(), line: z.number().optional() }))
      .optional(),
    /** Stable id for the message this chunk belongs to. */
    messageId: z.string().optional(),
    /** Monotonic ordering hint within the session. */
    seq: z.number().optional(),
  })
  .strict();

export type AcpSessionUpdateEvent = z.infer<typeof AcpSessionUpdateEventSchema>;
