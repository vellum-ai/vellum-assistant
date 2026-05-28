/**
 * Wire contract for the memory v2 activation log surfaced in the
 * inspector's Memory tab. Mirrors the return value of
 * `getMemoryV2ActivationLogByMessageIds` in
 * `assistant/src/memory/memory-v2-activation-log-store.ts`.
 *
 * Canonical wire-contract source. Assistant code imports the types
 * directly from this file via relative paths; external consumers
 * (web client, gateway, evals) import via `@vellumai/assistant-api`.
 *
 * Returned as part of `LlmContextResponse` — see
 * `./llm-context-response.ts`.
 *
 * Note: daemon emits the `config` block with snake_case keys; the
 * schema below preserves that on the wire.
 */

import { z } from "zod";

/**
 * One concept row in the V2 activation log. Mirrors
 * `MemoryV2ConceptRowRecord` from
 * `assistant/src/memory/memory-v2-activation-log-store.ts`.
 *
 * `source` and `status` are open-ended strings on the wire — the
 * daemon emits known values like `prior_state`, `ann_top50`, `both`
 * for `source` and `in_context`, `injected`, `not_injected`,
 * `page_missing` for `status`, but the schema stays permissive so a
 * new daemon value doesn't break parsing on the FE.
 */
export const MemoryV2ConceptRowSchema = z.object({
  slug: z.string(),
  finalActivation: z.number(),
  ownActivation: z.number(),
  priorActivation: z.number(),
  simUser: z.number(),
  simAssistant: z.number(),
  simNow: z.number(),
  simUserRerankBoost: z.number().optional(),
  simAssistantRerankBoost: z.number().optional(),
  inRerankPool: z.boolean().optional(),
  spreadContribution: z.number(),
  source: z.string(),
  status: z.string(),
});

export type MemoryV2ConceptRow = z.infer<typeof MemoryV2ConceptRowSchema>;

/**
 * Config snapshot used when the V2 activation ran. Mirrors
 * `MemoryV2ConfigSnapshot` (daemon uses snake_case keys).
 */
export const MemoryV2ConfigSnapshotSchema = z.object({
  d: z.number(),
  c_user: z.number(),
  c_assistant: z.number(),
  c_now: z.number(),
  k: z.number(),
  hops: z.number(),
  top_k: z.number(),
  epsilon: z.number(),
});

export type MemoryV2ConfigSnapshot = z.infer<
  typeof MemoryV2ConfigSnapshotSchema
>;

/**
 * Memory v2 activation log shape.
 */
export const MemoryV2ActivationLogSchema = z.object({
  turn: z.number(),
  mode: z.string(),
  concepts: z.array(MemoryV2ConceptRowSchema),
  config: MemoryV2ConfigSnapshotSchema,
});

export type MemoryV2ActivationLog = z.infer<typeof MemoryV2ActivationLogSchema>;
