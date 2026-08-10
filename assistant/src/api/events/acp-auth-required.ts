/**
 * `acp_auth_required` SSE event.
 *
 * Server to client notification that an ACP run failed because the agent
 * rejected its stored credential, and the client can offer a re-authentication
 * affordance. Always emitted immediately AFTER the `acp_session_error` that
 * carries the human-readable failure.
 *
 * WHY A SEPARATE EVENT RATHER THAN A FIELD ON `acp_session_error`
 *
 * Every event schema here is `.strict()`, and clients parse with
 * `AssistantEventSchema.safeParse`, falling back to an inert `unknown` event
 * when parsing fails. A NEW FIELD on an existing event is therefore not
 * backward compatible: an older packaged client (iOS and macOS bundle the web
 * app, so they can lag the daemon) has the pre-change strict schema, rejects
 * the whole event over the unrecognized key, and never handles it. For
 * `acp_session_error` that would leave the run rendering as still active
 * forever, which is worse than the plain failure it replaced.
 *
 * An unrecognized event TYPE degrades cleanly instead: it becomes the `unknown`
 * event and is ignored. So old clients keep seeing an unchanged
 * `acp_session_error` and render the failure exactly as before, while new
 * clients additionally receive this and can offer the fix. Prefer this shape
 * for any future additive signal on an existing event.
 *
 * Canonical wire-contract source. Re-exported to external consumers via
 * `@vellumai/assistant-api` (the `api/index.ts` barrel).
 */

import { z } from "zod";

export const AcpAuthRequiredEventSchema = z
  .object({
    type: z.literal("acp_auth_required"),
    acpSessionId: z.string(),
    /**
     * Stable classification of what kind of re-authentication is needed, so
     * clients branch on a machine-readable value rather than on the failure
     * text (which varies by adapter and is routinely replaced by whatever the
     * adapter last wrote to stderr). Currently only
     * `acp_claude_auth_required`; see `acp/auth-required.ts`.
     */
    authCode: z.string(),
    /** Agent id the run was spawned with, for display. */
    agent: z.string(),
    /**
     * Tool-use id of the `acp_spawn` call that started this run, so the client
     * can anchor an inline affordance to the right transcript row. Absent when
     * the run was not started by a tool call.
     */
    parentToolUseId: z.string().optional(),
  })
  .strict();

export type AcpAuthRequiredEvent = z.infer<typeof AcpAuthRequiredEventSchema>;
