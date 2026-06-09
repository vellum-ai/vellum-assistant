/**
 * Inline single-tool chip rendered for a LONE renderable tool call — a merged
 * activity run that resolves to exactly one simple (non-web, no-confirmation)
 * tool with no thinking. Renders through the shared {@link InlineActivityLink}
 * so it matches the lone "Thought process" link visually (same icon size,
 * typography, active state, chevron) while keeping the call's risk badge.
 *
 * Clicking toggles the shared tool-detail side drawer for this call — an
 * already-open chip closes it. The drawer payload is built via the shared
 * {@link toolDetailPayloadFromToolCall} so it is identical to the in-card
 * tool-step pill's payload.
 */

import { Bolt } from "lucide-react";

import { InlineActivityLink } from "@/domains/chat/components/inline-activity-link/inline-activity-link";
import { ICON_MAP } from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import { deriveStepLabel } from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { toolDetailPayloadFromToolCall } from "@/domains/chat/utils/tool-call-card-utils";
import { useViewerStore } from "@/stores/viewer-store";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

export interface InlineToolLinkProps {
  toolCall: ChatMessageToolCall;
}

export function InlineToolLink({ toolCall }: InlineToolLinkProps) {
  const toggleToolDetail = useViewerStore.use.toggleToolDetail();
  const activeDetail = useViewerStore.use.activeToolDetail();

  const { iconName, activity, info, title } = deriveStepLabel(toolCall);
  const Glyph = ICON_MAP[iconName] ?? Bolt;
  const label = activity || info || title;

  // A lone run never opens the drawer for a thinking payload; match purely on
  // the active tool-call id.
  const isActive =
    activeDetail != null &&
    activeDetail.kind !== "thinking" &&
    activeDetail.toolCallId === toolCall.id;

  const isError =
    Boolean(toolCall.isError) ||
    toolCall.confirmationDecision === "denied" ||
    toolCall.confirmationDecision === "timed_out";

  return (
    <InlineActivityLink
      data-testid="inline-tool-link"
      ariaLabel={`View details: ${label}`}
      // Running state just shows the static tool icon (no spinner) — a lone
      // fast tool resolves quickly, so the spinner-free chip is acceptable.
      icon={<Glyph className="size-4 shrink-0 text-[var(--content-tertiary)]" aria-hidden />}
      label={label}
      riskLevel={toolCall.riskLevel}
      tone={isError ? "error" : "default"}
      active={isActive}
      onClick={() => toggleToolDetail(toolDetailPayloadFromToolCall(toolCall))}
    />
  );
}
