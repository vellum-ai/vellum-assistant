/**
 * The header pieces a panel shows once it drills into one step of a run (the
 * activity steps panel, the subagent panel): the step's glyph beside the Back
 * button, and the step's title. Shared so a step reads the same in the header
 * of every panel that can open it.
 */

import { Bolt } from "lucide-react";

import {
  deriveStepLabelFromName,
  type IconName,
} from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { ICON_MAP } from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import { toolDetailHeaderTitle } from "@/domains/chat/components/tool-detail-panel";
import {
  useLiveToolCall,
  type ToolCallSource,
} from "@/domains/chat/hooks/use-live-tool-call";
import { isToolCallRunning } from "@/domains/chat/utils/tool-call-status";
import { useTranslation } from "@/i18n";
import type { ToolDetailPayload } from "@/stores/viewer-store";

/**
 * The icon name for a step: the same glyph its pill shows, a globe for a web
 * search, a brain for a thinking segment, otherwise the tool-type icon
 * `deriveStepLabelFromName` resolves (code brackets for bash). Resolved through
 * the shared `ICON_MAP` so the header and the pills never drift.
 */
function iconNameForDetail(detail: ToolDetailPayload): IconName {
  if (detail.kind === "web_search") {
    return "globe";
  }
  if (detail.kind === "thinking") {
    return "brain";
  }
  return deriveStepLabelFromName(detail.toolName, detail.input).iconName;
}

/**
 * The step's glyph: the running indicator while the step is in flight,
 * otherwise the step's own icon. Whether it is in flight is read live from
 * `source`, as `ToolDetailBody` reads it, so a step opened while running
 * turns to its icon when the body beside it shows the result.
 */
export function StepDetailGlyph({
  detail,
  source,
}: {
  detail: ToolDetailPayload;
  /** Where the call lives, the same source the step's body reads. */
  source: ToolCallSource;
}) {
  const liveTc = useLiveToolCall(source, detail.toolCallId);
  const isRunning = liveTc
    ? isToolCallRunning(liveTc)
    : detail.status === "running";
  if (isRunning) {
    return (
      <ThreeDotIndicator
        className="shrink-0"
        data-testid="nested-detail-running"
      />
    );
  }
  const Glyph = ICON_MAP[iconNameForDetail(detail)] ?? Bolt;
  return (
    <Glyph
      aria-hidden
      className="h-5 w-5 shrink-0 text-[var(--content-secondary)]"
    />
  );
}

/**
 * The title a step's detail is headed with. A thinking segment is always
 * "Thinking", whichever surface built its payload; a tool is its activity
 * sentence (`toolDetailHeaderTitle`).
 */
export function useStepDetailTitle(
  detail: ToolDetailPayload | null | undefined,
): string {
  const { t } = useTranslation("chat");
  if (!detail) {
    return "";
  }
  return detail.kind === "thinking"
    ? t("thinkingDetail.title")
    : toolDetailHeaderTitle(detail);
}
