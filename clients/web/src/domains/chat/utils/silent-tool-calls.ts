/**
 * The tool calls the transcript draws nothing for.
 *
 * Two kinds live here:
 *
 * - **Bookkeeping.** Tools the assistant runs on its own behalf, whose whole
 *   effect is inside the assistant: writing a memory, reading one back, loading
 *   a skill body, messaging its own parent, filing a follow-up for itself.
 *   Nothing the user asked for happened, and nothing they can act on came back,
 *   so a step row for one reads as the assistant narrating its filing system.
 *   A `remember` that lands after a delivered reply is the sharpest case: the
 *   row appears under a finished answer and adds a step to the count.
 * - **Surface tools.** `ui_show` / `ui_update` / `ui_dismiss` draw through the
 *   inline surface widget instead of a chip, so a chip beside the surface is a
 *   second drawing of one action. A call holding a pending confirmation is the
 *   exception: the chip is what carries the inline confirmation card.
 *
 * Anything with a real side effect or a real wait stays visible: web fetches,
 * bash, file writes, `messaging_send`, `subagent_spawn`, the schedule tools,
 * and `ask_question` (which renders its own answered card, and whose chip is
 * the only trace of a question that was never answered).
 */

import { SEND_USER_MESSAGE_TOOL_NAME } from "@/domains/chat/utils/assistant-text-visibility";

/** A tool call as this module reads it: the name, and any pending confirmation. */
export interface SilentToolCandidate {
  name: string;
  pendingConfirmation?: unknown;
}

/**
 * The surface tools, whose output the inline surface widget owns. Named here so
 * the transcript's own suppression and the silent-tool drop read one list.
 */
const UI_SURFACE_TOOL_NAMES = new Set(["ui_show", "ui_update", "ui_dismiss"]);

/**
 * The bookkeeping tools. Verified against `assistant/src/tools` and
 * `assistant/src/plugins/defaults`, so a name here is a tool the daemon can
 * actually emit rather than one this client hopes exists.
 */
const BOOKKEEPING_TOOL_NAMES = new Set([
  SEND_USER_MESSAGE_TOOL_NAME,
  // Memory plugin (`plugins/defaults/memory/tools.ts`).
  "remember",
  "recall",
  "delete_memory_page",
  // Subagent chatter (`tools/subagent/`).
  "notify_parent",
  "subagent_message",
  // Skill body loads (`tools/workspace-tools/loader.ts`).
  "skill_load",
  // Follow-ups the assistant files for itself (`tools/followups/`).
  "followup_create",
  "followup_resolve",
]);

/**
 * Whether a call is a surface tool the inline widget already draws. A pending
 * confirmation keeps it visible, because the chip is where that confirmation
 * renders.
 */
export function isUiSurfaceToolCall(toolCall: SilentToolCandidate): boolean {
  return !toolCall.pendingConfirmation && UI_SURFACE_TOOL_NAMES.has(toolCall.name);
}

/**
 * Whether a tool call is one the transcript draws nothing for. Structural in
 * its argument so the render path, the projection, and the activity drawer can
 * all ask without any of them owning the answer.
 */
export function isSilentToolCall(toolCall: SilentToolCandidate): boolean {
  return (
    BOOKKEEPING_TOOL_NAMES.has(toolCall.name) || isUiSurfaceToolCall(toolCall)
  );
}
