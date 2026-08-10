/**
 * `acp_session_error` SSE event.
 *
 * Server → client notification that an ACP session has errored.
 * Carries the session identity and a human-readable `error` message.
 *
 * Canonical wire-contract source. Re-exported to external consumers via
 * `@vellumai/assistant-api` (the `api/index.ts` barrel).
 */

import { z } from "zod";

export const AcpSessionErrorEventSchema = z
  .object({
    type: z.literal("acp_session_error"),
    acpSessionId: z.string(),
    error: z.string(),
    /**
     * Stable classification of WHY the run failed, when the daemon can name it.
     * The `error` string above is for a human to read and is not stable enough
     * to branch on: it varies by adapter and is often replaced by whatever the
     * adapter last wrote to stderr. This field is what clients key off to offer
     * a targeted recovery affordance.
     *
     * Currently only `acp_claude_auth_required` (see `acp/auth-required.ts`).
     * Optional, and absent for ordinary failures.
     */
    errorCode: z.string().optional(),
  })
  .strict();

export type AcpSessionErrorEvent = z.infer<typeof AcpSessionErrorEventSchema>;
