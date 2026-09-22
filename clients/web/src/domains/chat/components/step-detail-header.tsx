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
 * otherwise the step's own icon.
 */
export function StepDetailGlyph({ detail }: { detail: ToolDetailPayload }) {
  if (detail.status === "running") {
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
