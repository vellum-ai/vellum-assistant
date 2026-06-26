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
  })
  .strict();

export type AcpSessionErrorEvent = z.infer<typeof AcpSessionErrorEventSchema>;
