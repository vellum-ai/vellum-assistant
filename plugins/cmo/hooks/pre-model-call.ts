/**
 * `pre-model-call` hook for the `cmo` plugin.
 *
 * Appends a single-line CMO activation pointer to the user-facing system prompt
 * so the model knows to put on the CMO hat — and reach for this plugin's skills
 * and tools — when a marketing need shows up. It is intentionally minimal: the
 * actual CMO depth lives in the on-demand `skills/`, which trigger only when the
 * user asks for marketing help. Mirrors the `caveman` injection pattern.
 *
 * Convention: the default export is the function the harness invokes.
 */

import type { PreModelCallContext } from "@vellumai/plugin-api";

import { CMO_FRAME, CMO_FRAME_MARKER } from "../src/cmo-frame.js";

export default function preModelCall(ctx: PreModelCallContext): void {
  // Only shape the user-facing reply; leave background/subagent/compaction calls
  // untouched (this hook fires before every provider call, so we must self-gate).
  if (ctx.callSite !== "mainAgent") return;
  if (ctx.systemPrompt === null) return;
  // Idempotent: the hook can fire more than once within a turn, so guard against
  // appending the frame twice.
  if (ctx.systemPrompt.includes(CMO_FRAME_MARKER)) return;

  ctx.systemPrompt = `${ctx.systemPrompt}\n\n${CMO_FRAME_MARKER}\n${CMO_FRAME}`;
  ctx.logger.debug({ plugin: "cmo" }, "injected CMO activation line");
}
