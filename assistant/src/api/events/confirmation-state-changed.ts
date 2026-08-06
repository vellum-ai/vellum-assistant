/**
 * `confirmation_state_changed` SSE event.
 *
 * Authoritative per-request confirmation state transition emitted by the
 * daemon. Clients must use this event (not local phrase inference) to
 * update confirmation-bubble state.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const ConfirmationStateChangedEventSchema = z.object({
  type: z.literal("confirmation_state_changed"),
  conversationId: z.string(),
  requestId: z.string(),
  state: z.enum([
    "pending",
    "approved",
    "denied",
    "timed_out",
    "resolved_stale",
  ]),
  source: z.enum(["button", "inline_nl", "auto_deny", "timeout", "system"]),
  /** requestId of the user message that triggered this transition. */
  causedByRequestId: z.string().optional(),
  /** Normalized user text for analytics/debug (e.g. "approve", "deny"). */
  decisionText: z.string().optional(),
  /** The tool_use block ID this confirmation applies to, for disambiguating parallel tool calls. */
  toolUseId: z.string().optional(),
});

export type ConfirmationStateChangedEvent = z.infer<
  typeof ConfirmationStateChangedEventSchema
>;
