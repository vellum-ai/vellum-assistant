/**
 * Registry of tool-specific activity renderers for the side drawer (LUM-2999).
 *
 * The drawer's default rendering is deliberately generic — raw JSON input, raw
 * text output — which reads poorly for the tools that run most often. This
 * registry is the seam for replacing that per tool, starting with the two skill
 * tools. Adding a tool means writing its renderer and adding one entry here;
 * everything not listed keeps the generic treatment.
 */

import { SkillExecuteDetail } from "@/domains/chat/components/tool-activity/skill-execute-detail";
import { SkillLoadDetail } from "@/domains/chat/components/tool-activity/skill-load-detail";
import type { ToolActivityRenderer } from "@/domains/chat/components/tool-activity/types";

const RENDERERS: Record<string, ToolActivityRenderer> = {
  // `skill_load`'s result *is* the skill body, so it owns the Output section
  // rather than letting the generic one dump the same text again as a `<pre>`.
  skill_load: { Component: SkillLoadDetail, ownsOutput: true },
  // `skill_execute` only reshapes the input envelope — the inner tool's output
  // is ordinary text and keeps the shared Output section.
  skill_execute: { Component: SkillExecuteDetail, ownsOutput: false },
};

/**
 * Look up the purpose-built renderer for `toolName`, or `undefined` when the
 * tool has none and should fall back to the generic input/output rendering.
 */
export function getToolActivityRenderer(
  toolName: string,
): ToolActivityRenderer | undefined {
  return RENDERERS[toolName.toLowerCase()];
}
