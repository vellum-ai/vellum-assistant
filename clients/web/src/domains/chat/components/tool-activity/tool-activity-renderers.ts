/**
 * The one place that decides which body renders a tool-call detail.
 *
 * The drawer's default rendering is deliberately generic (raw JSON input, raw
 * text output), which reads poorly for the tools that run most often. A tool
 * that deserves better registers here, and every panel that hosts a tool detail
 * gets it: `ToolDetailPanel`, `ActivityStepsPanel`, and `SubagentDetailPanel`
 * all render through `ToolDetailBody`, which consults this lookup. A renderer
 * reachable from only one of them would mean the same call reads differently
 * depending on which panel opened it.
 *
 * Everything not listed keeps the generic treatment.
 */

import { SkillExecuteDetail } from "@/domains/chat/components/tool-activity/skill-execute-detail";
import { SkillLoadDetail } from "@/domains/chat/components/tool-activity/skill-load-detail";
import type { ToolActivityRenderer } from "@/domains/chat/components/tool-activity/types";
import { WebFetchDetailView } from "@/domains/chat/components/web-fetch/web-fetch-detail-view";
import { WebSearchDetailView } from "@/domains/chat/components/web-search/web-search-detail-view";
import type { ToolDetailPayload } from "@/stores/viewer-store";

const RENDERERS: Record<string, ToolActivityRenderer> = {
  // `skill_load`'s result *is* the skill body, so it owns the Output section
  // rather than letting the generic one dump the same text again as a `<pre>`.
  skill_load: { Component: SkillLoadDetail, ownsOutput: true },
  // `skill_execute` only reshapes the input envelope — the inner tool's output
  // is ordinary text and keeps the shared Output section.
  skill_execute: { Component: SkillExecuteDetail, ownsOutput: false },
  // The fetched page is the result, presented as a page rather than as text.
  web_fetch: { Component: WebFetchDetailView, ownsOutput: true },
};

/** A search presents its query and sources in place of input and output. */
const WEB_SEARCH: ToolActivityRenderer = {
  Component: WebSearchDetailView,
  ownsOutput: true,
};

/**
 * The renderer for `detail`, or `undefined` when it should fall back to the
 * generic input/output rendering.
 *
 * Takes the whole payload rather than the tool name because not every choice is
 * a name lookup: a search is identified by its `kind`, and a failed one has no
 * sources to show, so it deliberately falls through to the generic body where
 * its error renders in full.
 */
export function getToolActivityRenderer(
  detail: ToolDetailPayload,
): ToolActivityRenderer | undefined {
  if (detail.kind === "web_search") {
    return detail.status === "error" ? undefined : WEB_SEARCH;
  }
  return RENDERERS[detail.toolName.toLowerCase()];
}
