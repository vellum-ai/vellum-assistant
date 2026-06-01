/**
 * `interaction_resolved` SSE event.
 *
 * Broadcast when a pending interaction (confirmation, secret, question,
 * host-proxy request) transitions to a resolved state. Clients use this
 * to drop attention / processing indicators without polling.
 *
 * `state` is the lifecycle outcome:
 *  - `approved` / `rejected` — user-facing confirmation outcome
 *  - `answered` — question / secret responded to
 *  - `cancelled` — runtime-side termination (timeout, abort, dispose,
 *    prompter shutdown)
 *  - `superseded` — invalidated by a newer event (auto-deny on enqueue,
 *    fresh user message arriving while a confirmation was outstanding).
 *
 * `kind` is the interaction category (`"confirmation"`, `"secret"`,
 * `"question"`, `"host_bash"`, …) — kept loose (`string`) on the wire
 * because the daemon emits it directly from the pending-interaction
 * map without enum narrowing. Web-side narrowing happens at the
 * attention-tracking allowlist boundary.
 *
 * Canonical wire-contract source. Daemon code imports the type directly
 * from this file; external consumers import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

export const InteractionResolutionStateSchema = z.enum([
  "approved",
  "rejected",
  "answered",
  "cancelled",
  "superseded",
]);

export type InteractionResolutionState = z.infer<
  typeof InteractionResolutionStateSchema
>;

export const InteractionResolvedEventSchema = z.object({
  type: z.literal("interaction_resolved"),
  requestId: z.string(),
  conversationId: z.string(),
  state: InteractionResolutionStateSchema,
  kind: z.string(),
});

export type InteractionResolvedEvent = z.infer<
  typeof InteractionResolvedEventSchema
>;
