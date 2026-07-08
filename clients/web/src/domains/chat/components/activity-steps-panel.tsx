/**
 * Side-drawer panel showing the FULL steps timeline of one activity group (a
 * contiguous thinking + tool run) — opened by clicking the group's inline
 * header in the transcript (see `MultiActivityGroup`).
 *
 * Two-level drawer:
 *
 *  - Level 1 — the phase-grouped steps timeline (matches Figma `6405-121430`):
 *    every thinking segment, tool call, and web search of the run, grouped
 *    under phase headers with status nodes and durations.
 *  - Level 2 — clicking a step drills into its detail (the reasoning
 *    markdown, or the tool's technical details + output) IN PLACE, with an
 *    explicit "All steps" back button to return to the timeline.
 *
 * Streams live: the panel re-derives the group's items from the transcript by
 * `(messageId, groupIndex)` via `useLiveActivityGroup`, so new steps append
 * and running steps settle while the panel is open. The payload's embedded
 * snapshot is the fallback when the live source can't be resolved (message
 * paged out, or identity-less callers like stories).
 */

import { Brain, ChevronLeft } from "lucide-react";
import { useState } from "react";

import { Button, Typography } from "@vellumai/design-library";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { DetailShell } from "@/domains/chat/components/detail-shell";
import { StreamingShimmerText } from "@/domains/chat/components/streaming-shimmer-text";
import {
  activityRunSummaryLabel,
  countStepOutcomes,
  deriveSummaryState,
} from "@/domains/chat/components/multi-activity-group/multi-activity-group";
import {
  DefaultStepPill,
  PhaseGroupedStepList,
} from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import { ToolStepPill } from "@/domains/chat/components/tool-progress-card/tool-step-pill";
import { ToolDetailBody } from "@/domains/chat/components/tool-detail-panel";
import {
  WebSearchErrorRow,
  WebSearchStepRow,
} from "@/domains/chat/components/web-search/web-search-step-row";
import { useLiveActivityGroup } from "@/domains/chat/hooks/use-live-activity-group";
import { useLiveThinkingText } from "@/domains/chat/hooks/use-live-thinking-text";
import { useToolCallCardDataFromItems } from "@/domains/chat/hooks/use-tool-call-card-data";
import {
  toolDetailPayloadFromToolCall,
  type ToolCallCardStep,
} from "@/domains/chat/utils/tool-call-card-utils";
import { truncate } from "@/domains/chat/utils/truncate";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type {
  ActivityStepsPayload,
  ToolDetailPayload,
} from "@/stores/viewer-store";

/**
 * Hard character cap on the thinking-step pill label. The pill already
 * truncates by container width, but reasoning text can be long enough to
 * dominate the timeline before that fires — this caps it well short so the
 * pill stays compact and the full text lives behind the drill-in level.
 */
const THINKING_PILL_MAX_CHARS = 60;

export function ActivityStepsPanel({
  payload,
  onClose,
}: {
  payload: ActivityStepsPayload;
  onClose: () => void;
}) {
  // Level-2 drill-in: the step detail currently open, or null for the
  // timeline. Local state — the drawer level is navigation within the panel,
  // not shared app state.
  const [stepDetail, setStepDetail] = useState<ToolDetailPayload | null>(null);

  const live = useLiveActivityGroup(payload.messageId, payload.groupIndex);
  const items = live?.items ?? payload.items;
  const toolCalls = live?.toolCalls ?? payload.toolCalls;
  const cardData = useToolCallCardDataFromItems(items);

  const outcomes = countStepOutcomes(cardData.steps);
  const summaryState = deriveSummaryState(cardData.state, cardData.steps);
  const isRunning = summaryState === "loading";
  const summary = activityRunSummaryLabel(
    summaryState,
    cardData.totalDurationLabel ?? "",
    outcomes.failed,
  );
  // Matches Figma `6405-121431`: while the run streams, the header shows the
  // LIVE step title ("Thinking", "Searching the web", …) through the
  // avatar-tinted shimmer; once terminal it settles on the duration summary
  // ("Worked for 28s"). Title-less steps (e.g. bash) fall back to the
  // summary's "Working…" label.
  const title = isRunning ? cardData.currentStepTitle || summary : summary;

  // The pill's click handler reads the raw call to build the detail payload.
  const toolCallById = new Map(toolCalls.map((tc) => [tc.id, tc]));

  return (
    <DetailShell
      // Title cluster per Figma: title · N steps — inline at the same size,
      // separated by a 3px midline dot, count in the secondary tone.
      titleNode={
        <span className="flex min-w-0 items-center gap-1.5 py-0.5">
          <Typography
            variant="title-medium"
            className="min-w-0 shrink truncate leading-snug text-[var(--content-default)]"
          >
            {isRunning ? (
              <StreamingShimmerText>{title}</StreamingShimmerText>
            ) : (
              title
            )}
          </Typography>
          {cardData.stepCount ? (
            <>
              <span
                aria-hidden
                className="size-[3px] shrink-0 rounded-full bg-[var(--content-tertiary)]"
              />
              <Typography
                variant="title-medium"
                className="shrink-0 whitespace-nowrap leading-snug text-[var(--content-secondary)]"
              >
                {cardData.stepCount}
              </Typography>
            </>
          ) : null}
        </span>
      }
      closeLabel="Close steps"
      onClose={onClose}
    >
      {stepDetail ? (
        <StepDetailLevel
          detail={stepDetail}
          onBack={() => setStepDetail(null)}
        />
      ) : (
        <PhaseGroupedStepList
          steps={cardData.steps}
          timeline
          renderStep={(step) => (
            <TimelineStep
              step={step}
              activeDetail={stepDetail}
              onOpenDetail={setStepDetail}
              lookupToolCall={(id) => toolCallById.get(id)}
              messageId={payload.messageId}
              groupIndex={payload.groupIndex}
            />
          )}
        />
      )}
    </DetailShell>
  );
}

/**
 * One step row in the level-1 timeline. Thinking and tool steps render as
 * clickable pills that drill into the level-2 detail; web-search steps keep
 * their dedicated favicon / error rows (their result links are the detail).
 */
function TimelineStep({
  step,
  activeDetail,
  onOpenDetail,
  lookupToolCall,
  messageId,
  groupIndex,
}: {
  step: ToolCallCardStep;
  activeDetail: ToolDetailPayload | null;
  onOpenDetail: (detail: ToolDetailPayload) => void;
  lookupToolCall: (id: string) => ChatMessageToolCall | undefined;
  messageId?: string;
  groupIndex?: number;
}) {
  // Thinking steps drill into the full reasoning markdown. Genuine reasoning
  // segments carry a `thinkingItemIndex` and a threaded message identity so
  // the detail level streams live; web-synthesized thinking steps
  // ("Reading …") have no backing reasoning item and fall back to the
  // snapshot text.
  if (step.kind === "thinking") {
    const target =
      messageId != null && step.thinkingItemIndex != null
        ? {
            messageId,
            thinkingGroupIndex: groupIndex,
            thinkingItemIndex: step.thinkingItemIndex,
          }
        : {};
    return (
      <ToolStepPill
        iconName="brain"
        label={truncate(step.text, THINKING_PILL_MAX_CHARS)}
        ariaLabel="View thinking"
        active={false}
        tone="default"
        onClick={() =>
          onOpenDetail({
            kind: "thinking",
            toolCallId: "",
            toolName: "",
            title: "Thinking",
            activity: "",
            input: {},
            status: "completed",
            thinkingText: step.text,
            ...target,
          })
        }
      />
    );
  }
  // Web rows keep their dedicated rendering — result links open directly.
  if (step.kind === "web_search") {
    return <WebSearchStepRow step={step} />;
  }
  if (step.kind === "web_search_error") {
    return <WebSearchErrorRow step={step} />;
  }
  if (step.kind !== "tool") {
    return <DefaultStepPill step={step} />;
  }
  const tc = lookupToolCall(step.toolCallId);
  return (
    <ToolStepPill
      iconName={step.iconName}
      label={step.activity || step.info || step.title}
      riskLevel={step.riskLevel}
      active={activeDetail?.toolCallId === step.toolCallId}
      tone={
        step.status === "error" || step.status === "denied"
          ? "error"
          : "default"
      }
      onClick={() => {
        if (!tc) {
          return;
        }
        onOpenDetail(toolDetailPayloadFromToolCall(tc));
      }}
    />
  );
}

/**
 * Level 2 — a single step's detail with the back affordance. Thinking details
 * render the live reasoning markdown; tool details reuse the shared
 * `ToolDetailBody` (technical details + streaming output).
 */
function StepDetailLevel({
  detail,
  onBack,
}: {
  detail: ToolDetailPayload;
  onBack: () => void;
}) {
  // Live reasoning for thinking details — streams while the panel is open,
  // falling back to the click-time snapshot when the source can't be
  // resolved. Called unconditionally (hook rules); no-ops for tool details.
  const liveThinking = useLiveThinkingText(
    detail.kind === "thinking" ? detail.messageId : undefined,
    detail.thinkingGroupIndex,
    detail.thinkingItemIndex,
  );

  return (
    <div className="flex flex-col gap-4">
      <Button
        variant="ghost"
        size="compact"
        onClick={onBack}
        aria-label="Back to all steps"
        className="-ml-2 w-fit gap-1 text-[var(--content-secondary)]"
      >
        <ChevronLeft className="size-4 shrink-0" aria-hidden />
        All steps
      </Button>
      {detail.kind === "thinking" ? (
        <div className="flex flex-col gap-3">
          <span className="flex items-center gap-2">
            <Brain
              className="size-4 shrink-0 text-[var(--content-secondary)]"
              aria-hidden
            />
            <Typography
              variant="body-medium-default"
              className="text-[var(--content-default)]"
            >
              Thinking
            </Typography>
          </span>
          <ChatMarkdownMessage
            content={liveThinking ?? detail.thinkingText ?? ""}
            hardLineBreaks
          />
        </div>
      ) : (
        <ToolDetailBody detail={detail} />
      )}
    </div>
  );
}
