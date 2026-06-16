/**
 * Default `pre-model-call` hook: for the user-facing reply on a weak open
 * model (see {@link isWeakOpenModel}), append two short behavioral directives
 * to the system prompt — verify-before-asserting and attempt-don't-ask.
 *
 * Motivation: on the `balanced-economy` profile (MiniMax M3) the assistant
 * asserted the user's site was hosted on Vercel (it runs on GCP) and, once
 * corrected, asked "do you have gcloud set up?" instead of just running it —
 * both behaviors the managed Claude profiles don't exhibit. The soul/bootstrap
 * prompt already carries "be resourceful before asking," but the weaker models
 * don't reliably follow prose that's shared with every model; this gives them a
 * firmer, model-gated restatement at the seam right before the provider call.
 *
 * Gated three ways so the cost lands only where it helps:
 * - `callSite === "mainAgent"` — only the user-facing reply. Background,
 *   subagent, compaction, and utility call sites run their own resolved models
 *   and don't need this coaching.
 * - the resolved main-agent model is a weak open model — managed Claude
 *   profiles pay nothing (the section is never appended for them).
 * - idempotent append — re-entrant provider calls within a turn never stack
 *   the block twice.
 *
 * The model is resolved from the workspace's active profile via
 * `resolveCallSiteConfig`, matching how the user selects a chat model
 * (`llm.activeProfile`). A per-conversation inference-profile override is not
 * visible at this seam, so a conversation that overrides onto a weak model
 * while the workspace active profile is a managed one is not coached; that is
 * the rare path and the failure mode is only a missing nudge, never a wrong
 * one.
 */

import type { PluginHookFn, PreModelCallContext } from "@vellumai/plugin-api";

import { resolveCallSiteConfig } from "../../../../config/llm-resolver.js";
import { getConfigReadOnly } from "../../../../config/loader.js";
import { isWeakOpenModel } from "../../../../providers/weak-open-model.js";

/**
 * The appended directives. Module-level constant so tests and any wrapping
 * plugin can match it without duplicating the string, and so the idempotency
 * guard can detect an already-appended block.
 */
export const INITIATIVE_COACHING_TEXT = `<initiative_and_grounding>
Two habits for this turn:

1. Verify before asserting. Before stating where something is hosted, deployed, stored, or configured — or any other fact about the user's systems you have not confirmed this session — check it with a read-only tool call. Do not infer it from which integrations are connected, and do not state it from memory. If you cannot verify it, say so instead of guessing.

2. Attempt, don't ask. When you need a tool, connection, or credential to make progress, try it and handle any failure — do not ask the user whether it is set up or available. Ask only after an attempt actually fails, or when the action is destructive or genuinely ambiguous.
</initiative_and_grounding>`;

const preModelCall: PluginHookFn<PreModelCallContext> = async (ctx) => {
  if (ctx.callSite !== "mainAgent") return;
  if (ctx.systemPrompt == null) return;
  // Re-entrant calls within a turn rebuild from the base prompt, but guard
  // anyway so the block is never stacked.
  if (ctx.systemPrompt.includes(INITIATIVE_COACHING_TEXT)) return;

  let model: string;
  try {
    model = resolveCallSiteConfig("mainAgent", getConfigReadOnly().llm).model;
  } catch {
    // Config unavailable — leave the prompt untouched.
    return;
  }
  if (!isWeakOpenModel(model)) return;

  ctx.systemPrompt = `${ctx.systemPrompt}\n\n${INITIATIVE_COACHING_TEXT}`;
  ctx.logger.info(
    { plugin: "agentic-initiative", model },
    "Appended initiative + grounding coaching for weak open model",
  );
};

export default preModelCall;
