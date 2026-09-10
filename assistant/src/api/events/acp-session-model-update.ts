/**
 * `acp_session_model_update` SSE event.
 *
 * Server to client snapshot of an ACP session's model selection, derived from
 * the adapter's `configOptions`. `model` is the currently selected value (absent
 * when the adapter reports none) and `availableModels` is the flattened set of
 * values the adapter offers, empty when it advertises no model selector.
 * `modelRevisionEpoch` scopes `modelRevision` to one assistant process, and
 * the pair orders this snapshot against the same session state returned by
 * `GET /v1/acp/sessions`. A side gauge, not part of the ordered update
 * timeline: carries no `seq`.
 *
 * `.strict()` like the other ACP events, for the reason spelled out in
 * `acp-auth-required.ts`: an older packaged client rejects an event carrying a
 * field it does not know, so additive signals get their own event type.
 *
 * Canonical wire-contract source. Re-exported to external consumers via
 * `@vellumai/assistant-api` (the `api/index.ts` barrel).
 */

import { z } from "zod";

export const AcpSessionModelUpdateEventSchema = z
  .object({
    type: z.literal("acp_session_model_update"),
    acpSessionId: z.string(),
    modelRevisionEpoch: z.string().uuid(),
    modelRevision: z.number().int().nonnegative(),
    model: z.string().optional(),
    availableModels: z.array(
      z.object({
        /** Adapter-reported value to pass back when selecting this model. */
        value: z.string(),
        /** Human-readable label from the adapter. */
        label: z.string(),
        description: z.string().optional(),
        /** Name of the adapter's option group, when the options were grouped. */
        group: z.string().optional(),
      }),
    ),
  })
  .strict();

export type AcpSessionModelUpdateEvent = z.infer<
  typeof AcpSessionModelUpdateEventSchema
>;
