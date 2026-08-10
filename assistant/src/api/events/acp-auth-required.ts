/**
 * `acp_auth_required` SSE event.
 *
 * Server to client notification that an ACP run failed because the agent
 * rejected its stored credential and the client can offer a re-authentication
 * affordance. Always emitted immediately AFTER the `acp_session_error` that
 * carries the human-readable failure.
 *
 * It is a separate event rather than a field on `acp_session_error` because
 * every event schema here is `.strict()` and clients fall back to an inert
 * `unknown` event when parsing fails: a new FIELD makes an older packaged
 * client (iOS/macOS bundle the web app) reject the whole error event and
 * render the run as still active, while an unknown event TYPE is simply
 * ignored. Additive signals on existing events need their own event type for
 * the same reason.
 *
 * Canonical wire-contract source. Re-exported to external consumers via
 * `@vellumai/assistant-api` (the `api/index.ts` barrel).
 */

import { z } from "zod";

/**
 * The code for a `claude-agent-acp` run whose Claude credential needs to be
 * reconnected: the `authCode` on this event for post-spawn failures, and the
 * `errorCode` on the failed `acp_spawn` tool result for pre-spawn ones.
 * Single source for both sides of the wire: the daemon re-exports it via
 * `acp/auth-required.ts`, the web client via
 * `domains/chat/utils/acp-connect.ts`.
 */
export const ACP_CLAUDE_AUTH_REQUIRED_CODE = "acp_claude_auth_required";

export const AcpAuthRequiredEventSchema = z
  .object({
    type: z.literal("acp_auth_required"),
    acpSessionId: z.string(),
    /**
     * Machine-readable classification of what kind of re-authentication is
     * needed, so clients branch on a stable value rather than on the failure
     * text (which varies by adapter and failure mode). Currently only
     * {@link ACP_CLAUDE_AUTH_REQUIRED_CODE}.
     */
    authCode: z.string(),
    /** Agent id the run was spawned with, for display. */
    agent: z.string(),
    /**
     * Tool-use id of the `acp_spawn` call that started this run, so the
     * client anchors the inline affordance to the right transcript row.
     * Absent when the run was not started by a tool call.
     */
    parentToolUseId: z.string().optional(),
  })
  .strict();

export type AcpAuthRequiredEvent = z.infer<typeof AcpAuthRequiredEventSchema>;
