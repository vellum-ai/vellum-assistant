/**
 * `pre-model-call` hook for the `marketing-expert` plugin.
 *
 * Appends a single-line activation pointer to the user-facing system prompt so
 * the model knows to put on the marketing-expert hat — and reach for this
 * plugin's skills and tools — when a marketing need shows up. It is
 * intentionally minimal: the actual depth lives in the on-demand `skills/`,
 * which trigger only when the user asks for marketing help. Mirrors the
 * `caveman` injection pattern.
 *
 * Convention: the default export is the function the harness invokes.
 */

import type { PreModelCallContext } from "@vellumai/plugin-api";

import {
  MARKETING_EXPERT_FRAME,
  MARKETING_EXPERT_FRAME_MARKER,
} from "../src/marketing-expert-frame.js";

export default function preModelCall(ctx: PreModelCallContext): void {
  // Only shape the user-facing reply; leave background/subagent/compaction calls
  // untouched (this hook fires before every provider call, so we must self-gate).
  if (ctx.callSite !== "mainAgent") return;
  if (ctx.systemPrompt === null) return;
  // Idempotent: the hook can fire more than once within a turn, so guard against
  // appending the frame twice.
  if (ctx.systemPrompt.includes(MARKETING_EXPERT_FRAME_MARKER)) return;

  ctx.systemPrompt = `${ctx.systemPrompt}\n\n${MARKETING_EXPERT_FRAME_MARKER}\n${MARKETING_EXPERT_FRAME}`;
  ctx.logger.debug({ plugin: "marketing-expert" }, "injected marketing-expert activation line");
}
