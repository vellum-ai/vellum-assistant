/**
 * `acp_session_error` SSE event.
 *
 * Server → client notification that an ACP session has errored.
 * Carries the session identity and a human-readable `error` message.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
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
