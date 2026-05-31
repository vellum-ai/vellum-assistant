/**
 * `AssistantEventEnvelope` — the SSE wire envelope wrapping every outbound
 * event from the daemon.
 *
 * The daemon emits events as JSON-serialized envelopes:
 *
 *   { id, conversationId?, seq?, emittedAt, message: { type, ...fields } }
 *
 * `message` is the semantic event payload (validated separately by
 * `AssistantEventSchema`). The envelope carries transport-level metadata
 * — a per-event UUID, an optional monotonic sequence number for gap
 * detection, and an emission timestamp.
 *
 * Canonical wire-contract source. External consumers import via
 * `@vellumai/assistant-api`.
 *
 * @see https://html.spec.whatwg.org/multipage/server-sent-events.html
 */

import { z } from "zod";

/**
 * Zod schema for the outer envelope structure. Validates transport-level
 * fields without constraining the inner `message` — inner-event validation
 * is handled separately by `AssistantEventSchema` (canonical) or the
 * legacy parser fallback.
 */
export const AssistantEventEnvelopeSchema = z.object({
  id: z.string(),
  conversationId: z.string().optional(),
  seq: z.number().int().optional(),
  emittedAt: z.string(),
  message: z.record(z.string(), z.unknown()),
});

/**
 * Generic envelope interface. `TMessage` defaults to `unknown` so the
 * schema package stays payload-agnostic; consumers narrow it to their
 * event union (e.g. `AssistantEventEnvelope<AssistantEvent>`).
 */
export type AssistantEventEnvelope<TMessage = unknown> = Omit<
  z.infer<typeof AssistantEventEnvelopeSchema>,
  "message"
> & {
  message: TMessage;
};
