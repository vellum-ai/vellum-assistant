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

import { BashDetail } from "@/domains/chat/components/tool-activity/bash-detail";
import { FileChangeDetail } from "@/domains/chat/components/tool-activity/file-change-detail";
import { AskQuestionDetail } from "@/domains/chat/components/tool-activity/ask-question-detail";
import { RecallDetail } from "@/domains/chat/components/tool-activity/recall-detail";
import { RememberDetail } from "@/domains/chat/components/tool-activity/remember-detail";
import { SkillExecuteDetail } from "@/domains/chat/components/tool-activity/skill-execute-detail";
import { SkillLoadDetail } from "@/domains/chat/components/tool-activity/skill-load-detail";
import type { ToolActivityRenderer } from "@/domains/chat/components/tool-activity/types";
import { WebFetchDetailView } from "@/domains/chat/components/web-fetch/web-fetch-detail-view";
import { WebSearchDetailView } from "@/domains/chat/components/web-search/web-search-detail-view";
import type { ToolDetailPayload } from "@/stores/viewer-store";

const RENDERERS: Record<string, ToolActivityRenderer> = {
  // A command and what it printed, rather than a JSON object quoting one. What
  // it printed is shown as printed, so that is the raw output too.
  bash: { Component: BashDetail, output: "verbatim" },
  host_bash: { Component: BashDetail, output: "verbatim" },
  // One body for every tool that changes a file. The daemon returns the same
  // `{ filePath, oldContent, newContent, isNewFile }` for a write as for an
  // edit, so they are one thing here too, and the label saying whether it was
  // applied is written once rather than per tool.
  file_edit: { Component: FileChangeDetail, output: "shared" },
  host_file_edit: { Component: FileChangeDetail, output: "shared" },
  file_write: { Component: FileChangeDetail, output: "shared" },
  host_file_write: { Component: FileChangeDetail, output: "shared" },
  // `skill_load`'s result *is* the skill body, so it owns the Output section
  // rather than letting the generic one dump the same text again as a `<pre>`.
  skill_load: { Component: SkillLoadDetail, output: "own" },
  // `skill_execute` only reshapes the input envelope; the inner tool's output
  // is ordinary text and keeps the shared Output section.
  skill_execute: { Component: SkillExecuteDetail, output: "shared" },
  // The fetched page is the result, presented as a page rather than as text.
  web_fetch: { Component: WebFetchDetailView, output: "own" },
  // The facts saved, as a list. The result only confirms the save, which the
  // list's label says, so it is offered raw rather than repeated.
  remember: { Component: RememberDetail, output: "own" },
  // The answer and the evidence under it, read from the structured result.
  recall: { Component: RecallDetail, output: "own" },
  // What was asked and what the user chose. The result is the answer written
  // for the model, which the questions above already say, so it is offered
  // raw rather than repeated.
  ask_question: { Component: AskQuestionDetail, output: "own" },
};

/** A search presents its query and sources in place of input and output. */
const WEB_SEARCH: ToolActivityRenderer = {
  Component: WebSearchDetailView,
  output: "own",
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
