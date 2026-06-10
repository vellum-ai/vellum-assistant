/**
 * Inline single-activity link — the lone affordance for ONE step of agent work,
 * in one of two variants:
 *
 *   - `variant="thinking"` — an assistant reasoning run. A brain glyph +
 *     "Thought process", or the shared {@link ThreeDotIndicator} + "Thinking"
 *     while streaming. OWNS the streaming/loading state so it can be the single
 *     thinking affordance from the start of a turn, staying clickable so the
 *     live reasoning opens in the drawer as it arrives; no-ops once settled with
 *     empty content (see `shouldShowThinkingIndicator`).
 *   - `variant="tool"` — a LONE renderable tool call (non-web, no confirmation,
 *     no thinking). The derived tool glyph + activity label + optional risk
 *     badge.
 *
 * Both variants render the same minimal, container-less button (leading glyph +
 * label + optional risk badge + trailing chevron) and toggle the shared
 * tool-detail side drawer — clicking an already-open link closes it (toggle).
 * The trailing `ChevronRight` signals "opens a drawer" (vs the card's
 * expand-in-place up/down chevron). Consistent padding lets the active highlight
 * fill behind the content without shifting layout.
 *
 * This is the single-step counterpart to `MultiActivityGroup`, which renders a
 * contiguous run of interleaved thinking + tool steps as one combined card.
 */

import { Bolt, Brain, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/utils/misc";
import { RiskBadge } from "@/domains/chat/components/risk-badge";
import { ThreeDotIndicator } from "@/domains/chat/components/tool-progress-card/three-dot-indicator";
import { ICON_MAP } from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import { deriveStepLabel } from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { toolDetailPayloadFromToolCall } from "@/domains/chat/utils/tool-call-card-utils";
import { useViewerStore } from "@/stores/viewer-store";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

export type SingleActivityProps =
  | {
      variant: "thinking";
      /** The accumulated reasoning text (markdown), shown in the drawer. */
      content: string;
      /** Whether the reasoning is still streaming in (drives the glyph + label). */
      isStreaming?: boolean;
    }
  | {
      variant: "tool";
      toolCall: ChatMessageToolCall;
    };

/** The shared presentational shape both variants resolve into. */
interface ResolvedView {
  dataTestId: string;
  ariaLabel: string;
  icon: ReactNode;
  label: string;
  riskLevel?: string;
  tone: "default" | "error";
  active: boolean;
  onClick: () => void;
}

export function SingleActivity(props: SingleActivityProps) {
  // Both variants TOGGLE the shared tool-detail drawer and read its active
  // payload to drive the selected highlight. Hooks run unconditionally; the only
  // early return (empty, settled thinking) happens after them below.
  const toggleToolDetail = useViewerStore.use.toggleToolDetail();
  const activeDetail = useViewerStore.use.activeToolDetail();

  let view: ResolvedView;

  if (props.variant === "thinking") {
    const { content, isStreaming = false } = props;
    // While streaming, render even before any reasoning text has landed so this
    // link can be the single thinking affordance from the start of the turn.
    // Once settled, an empty thought process has nothing to show, so collapse it.
    if (!content && !isStreaming) return null;
    view = {
      dataTestId: "thought-process-link",
      ariaLabel: "View thinking",
      icon: isStreaming ? (
        <ThreeDotIndicator
          data-testid="thought-process-loading"
          className="shrink-0"
        />
      ) : (
        <Brain className="size-4 shrink-0" aria-hidden />
      ),
      label: isStreaming ? "Thinking" : "Thought process",
      tone: "default",
      // Thinking payloads carry an empty `toolCallId`, so we match on the
      // thinking text instead (mirrors the in-card thinking pill).
      active:
        activeDetail?.kind === "thinking" &&
        activeDetail.thinkingText === content,
      onClick: () =>
        toggleToolDetail({
          kind: "thinking",
          toolCallId: "",
          toolName: "",
          title: "Thought process",
          activity: "",
          input: {},
          status: "completed",
          thinkingText: content,
        }),
    };
  } else {
    const { toolCall } = props;
    const { iconName, activity, info, title } = deriveStepLabel(toolCall);
    const Glyph = ICON_MAP[iconName] ?? Bolt;
    const label = activity || info || title;
    const isError =
      Boolean(toolCall.isError) ||
      toolCall.confirmationDecision === "denied" ||
      toolCall.confirmationDecision === "timed_out";
    view = {
      dataTestId: "inline-tool-link",
      ariaLabel: `View details: ${label}`,
      // Running state just shows the static tool icon (no spinner) — a lone fast
      // tool resolves quickly, so the spinner-free chip is acceptable.
      icon: (
        <Glyph
          className="size-4 shrink-0 text-[var(--content-tertiary)]"
          aria-hidden
        />
      ),
      label,
      riskLevel: toolCall.riskLevel,
      tone: isError ? "error" : "default",
      // A lone run never opens the drawer for a thinking payload; match purely
      // on the active tool-call id.
      active:
        activeDetail != null &&
        activeDetail.kind !== "thinking" &&
        activeDetail.toolCallId === toolCall.id,
      onClick: () => toggleToolDetail(toolDetailPayloadFromToolCall(toolCall)),
    };
  }

  const isError = view.tone === "error";
  return (
    <button
      type="button"
      data-testid={view.dataTestId}
      data-active={view.active ? "true" : "false"}
      aria-label={view.ariaLabel}
      onClick={view.onClick}
      className={cn(
        "group inline-flex items-center gap-2 -mx-1.5 px-1.5 py-1 rounded-md text-left text-[13px] font-medium transition-colors cursor-pointer",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]",
        view.active
          ? "bg-[var(--surface-active)] text-[var(--content-default)]"
          : "text-[var(--content-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
        isError && "text-[var(--system-negative-strong)]",
      )}
    >
      <span
        className={cn(
          "inline-flex shrink-0 items-center text-[var(--content-tertiary)]",
          isError && "text-[var(--system-negative-strong)]",
        )}
      >
        {view.icon}
      </span>
      <span>{view.label}</span>
      {view.riskLevel ? <RiskBadge level={view.riskLevel} /> : null}
      <ChevronRight
        className="size-3.5 shrink-0 text-[var(--content-tertiary)]"
        aria-hidden
      />
    </button>
  );
}
