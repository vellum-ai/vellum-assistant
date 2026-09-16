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

import { ChevronLeft } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Button, Typography } from "@vellumai/design-library";
import { isComputerUseToolCall } from "@vellumai/assistant-api";

import {
  DetailShell,
  DetailShellTitleWithCount,
} from "@/components/detail-shell";
import { useTranslation } from "@/i18n";
import { StreamingShimmerText } from "@/domains/chat/components/streaming-shimmer-text";
import {
  activityRunSummaryLabel,
  countStepOutcomes,
  deriveSummaryState,
} from "@/domains/chat/components/multi-activity-group/multi-activity-group";
import {
  DefaultStepPill,
  isWorkingPhaseLabel,
  PhaseGroupedStepList,
  type PhaseSection,
} from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import { ActivityScreenshotTile } from "@/domains/chat/components/activity-screenshot-tile";
import {
  projectToolResultImages,
  type ToolResultImage,
} from "@/domains/chat/components/chat-attachments/tool-result-images";
import { useAttachmentPreview } from "@/domains/chat/components/chat-attachments/use-attachment-preview";
import { ToolStepPill } from "@/domains/chat/components/tool-progress-card/tool-step-pill";
import { ThinkingDetailMarkdown } from "@/domains/chat/components/thinking-detail-markdown";
import {
  ToolDetailBody,
  ToolDetailHeaderTitle,
} from "@/domains/chat/components/tool-detail-panel";
import {
  WebSearchErrorRow,
  WebSearchStepRow,
} from "@/domains/chat/components/web-search/web-search-step-row";
import { useLiveActivityGroup } from "@/domains/chat/hooks/use-live-activity-group";
import { TRANSCRIPT_TOOL_CALL_SOURCE } from "@/domains/chat/hooks/use-live-tool-call";
import { useToolCallCardDataFromItems } from "@/domains/chat/hooks/use-tool-call-card-data";
import { isActivityLive, useTurnStore } from "@/domains/chat/turn-store";
import {
  toolDetailPayloadFromToolCall,
  type ToolCallCardStep,
} from "@/domains/chat/utils/tool-call-card-utils";
import { thinkingPreview } from "@/domains/chat/utils/thinking-preview";
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

export interface ActivityScreenshotOccurrence {
  image: ToolResultImage;
  occurrenceKey: string;
}

/** Ordered computer screenshots joined to the rendered tool-step sequence. */
export function buildActivityScreenshotGallery(
  toolCalls: ChatMessageToolCall[],
  steps: ToolCallCardStep[],
): ActivityScreenshotOccurrence[] {
  return buildActivityScreenshotGalleryForIds(
    toolCalls,
    steps.flatMap((step) => (step.kind === "tool" ? [step.toolCallId] : [])),
  );
}

function buildActivityScreenshotGalleryForIds(
  toolCalls: ChatMessageToolCall[],
  orderedToolCallIds: string[],
): ActivityScreenshotOccurrence[] {
  const eligibleIds = new Set(
    toolCalls
      .filter((toolCall) =>
        isComputerUseToolCall(toolCall.name, toolCall.input),
      )
      .map((toolCall) => toolCall.id),
  );
  const imageByToolCallId = new Map<string, ToolResultImage>();
  for (const image of projectToolResultImages(toolCalls)) {
    if (eligibleIds.has(image.toolCallId)) {
      imageByToolCallId.set(image.toolCallId, image);
    }
  }

  const gallery: ActivityScreenshotOccurrence[] = [];
  const seen = new Set<string>();
  for (const toolCallId of orderedToolCallIds) {
    if (seen.has(toolCallId)) {
      continue;
    }
    const image = imageByToolCallId.get(toolCallId);
    if (image) {
      seen.add(toolCallId);
      gallery.push({ image, occurrenceKey: toolCallId });
    }
  }
  return gallery;
}

interface ActivityStepsPanelProps {
  payload: ActivityStepsPayload;
  onClose: () => void;
  /**
   * Assistant that owns the conversation this activity group belongs to.
   * Threaded to the drill-in reasoning markdown so workspace file references
   * resolve against the right workspace.
   */
  assistantId?: string | null;
}

export function ActivityStepsPanel({
  payload,
  onClose,
  assistantId,
}: ActivityStepsPanelProps) {
  return (
    <ActivityStepsPanelTarget
      key={activityStepsTargetKey(payload)}
      payload={payload}
      onClose={onClose}
      assistantId={assistantId}
    />
  );
}

function activityStepsTargetKey(payload: ActivityStepsPayload): string {
  if (payload.messageId != null) {
    const rawToolCallId = payload.groupToolCallIds?.[0];
    return rawToolCallId != null
      ? JSON.stringify(["message", payload.messageId, "tool", rawToolCallId])
      : JSON.stringify([
          "message",
          payload.messageId,
          "index",
          payload.groupIndex ?? null,
        ]);
  }

  const snapshotToolCallId = payload.toolCalls[0]?.id;
  return snapshotToolCallId != null
    ? JSON.stringify(["snapshot", "tool", snapshotToolCallId])
    : JSON.stringify(["snapshot", "index", payload.groupIndex ?? null]);
}

function ActivityStepsPanelTarget({
  payload,
  onClose,
  assistantId,
}: ActivityStepsPanelProps) {
  const { t } = useTranslation("chat");
  // Level-2 drill-in: the step detail currently open, or null for the
  // timeline. Local state — the drawer level is navigation within the panel,
  // not shared app state.
  const [stepDetail, setStepDetail] = useState<ToolDetailPayload | null>(null);

  const anchorToolCallId =
    payload.groupToolCallIds?.[0] ?? payload.toolCalls[0]?.id;

  const live = useLiveActivityGroup(
    payload.messageId,
    payload.groupIndex,
    anchorToolCallId,
  );
  const items = live?.items ?? payload.items;
  const toolCalls = live?.toolCalls ?? payload.toolCalls;
  const turnPhase = useTurnStore.use.phase();
  const ownsActiveGroup = live
    ? live.isLastGroup && live.isLatestMessage
    : payload.messageId == null;
  const active =
    payload.active === true && ownsActiveGroup && isActivityLive(turnPhase);
  const cardData = useToolCallCardDataFromItems(items, { active });
  const orderedToolCallIds = useMemo(
    () =>
      items.flatMap((item) =>
        item.kind === "toolCall" ? [item.toolCall.id] : [],
      ),
    [items],
  );
  const screenshotGallery = useMemo(
    () => buildActivityScreenshotGalleryForIds(toolCalls, orderedToolCallIds),
    [toolCalls, orderedToolCallIds],
  );
  const screenshotKeys = useMemo(
    () => screenshotGallery.map((entry) => entry.occurrenceKey),
    [screenshotGallery],
  );
  const screenshotIndexByToolCallId = useMemo(
    () =>
      new Map(
        screenshotGallery.map((entry, index) => [entry.occurrenceKey, index]),
      ),
    [screenshotGallery],
  );
  const screenshotImages = useMemo(
    () => screenshotGallery.map((entry) => entry.image),
    [screenshotGallery],
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const previewScope = `${assistantId ?? ""}:${payload.messageId ?? ""}:${anchorToolCallId ?? payload.groupIndex ?? ""}`;
  const { openPreview, previewModal } = useAttachmentPreview(
    assistantId,
    screenshotImages,
    screenshotKeys,
    {
      scopeKey: previewScope,
      getFallbackFocus: () =>
        panelRef.current?.querySelector<HTMLElement>(
          'button, [role="button"][tabindex="0"]',
        ) ?? null,
    },
  );

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
  const toolCallById = useMemo(
    () => new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall])),
    [toolCalls],
  );

  // Level-2 header title: the step's own label, prefixed by the back
  // chevron. Mirrors `ToolDetailPanel`'s activity-first title for tools.
  return (
    <div ref={panelRef} className="contents">
      <DetailShell
        // Drilled into a step, the back control takes the leading slot the glyph
        // would occupy: same placement, variant, and spacing as the subagent,
        // workflow, and ACP run panels' Back buttons.
        icon={
          stepDetail ? (
            <Button
              variant="outlined"
              iconOnly={<ChevronLeft />}
              aria-label={t("activityStepsPanel.backAria")}
              tooltip={t("activityStepsPanel.backTooltip")}
              onClick={() => setStepDetail(null)}
              className="shrink-0"
            />
          ) : undefined
        }
        titleNode={
          stepDetail ? (
            // Drilled into a step: the step's title replaces the run summary, so
            // the header always names what the body shows.
            stepDetail.kind === "thinking" ? (
              <Typography
                variant="title-medium"
                className="min-w-0 shrink truncate py-0.5 leading-snug text-[var(--content-default)]"
              >
                {t("activityStepsPanel.thinkingTitle")}
              </Typography>
            ) : (
              <ToolDetailHeaderTitle
                detail={stepDetail}
                source={TRANSCRIPT_TOOL_CALL_SOURCE}
              />
            )
          ) : (
            <DetailShellTitleWithCount
              title={
                isRunning ? (
                  <StreamingShimmerText>{title}</StreamingShimmerText>
                ) : (
                  title
                )
              }
              count={cardData.stepCount}
            />
          )
        }
        closeLabel={t("activityStepsPanel.closeSteps")}
        onClose={onClose}
      >
        {stepDetail ? (
          <StepDetailLevel detail={stepDetail} assistantId={assistantId} />
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
                groupIndex={live?.groupIndex ?? payload.groupIndex}
              />
            )}
            renderPhaseFooter={(section) => {
              const representative = phaseScreenshotRepresentative(
                section,
                screenshotGallery,
                screenshotIndexByToolCallId,
              );
              if (!representative) {
                return null;
              }
              const { entry, step, index } = representative;
              const activity = step.activity?.trim();
              const title = activity
                ? t("activityStepsPanel.screenshotTitle", { activity })
                : t("activityStepsPanel.screenshotFallbackTitle");
              const ariaLabel = activity
                ? t("activityStepsPanel.screenshotAria", { activity })
                : t("activityStepsPanel.screenshotFallbackAria");
              return (
                <ActivityScreenshotTile
                  assistantId={assistantId}
                  image={entry.image}
                  title={title}
                  ariaLabel={ariaLabel}
                  onPreview={(trigger) =>
                    openPreview(entry.image, index, trigger)
                  }
                />
              );
            }}
          />
        )}
        {previewModal}
      </DetailShell>
    </div>
  );
}

function phaseScreenshotRepresentative(
  section: PhaseSection,
  gallery: ActivityScreenshotOccurrence[],
  indexByToolCallId: ReadonlyMap<string, number>,
): {
  entry: ActivityScreenshotOccurrence;
  step: Extract<ToolCallCardStep, { kind: "tool" }>;
  index: number;
} | null {
  if (!isWorkingPhaseLabel(section.label)) {
    return null;
  }
  for (let index = section.steps.length - 1; index >= 0; index -= 1) {
    const step = section.steps[index];
    if (step?.kind !== "tool") {
      continue;
    }
    const galleryIndex = indexByToolCallId.get(step.toolCallId);
    if (galleryIndex !== undefined) {
      return {
        entry: gallery[galleryIndex]!,
        step,
        index: galleryIndex,
      };
    }
  }
  return null;
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
  const { t } = useTranslation("chat");
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
        label={truncate(thinkingPreview(step.text), THINKING_PILL_MAX_CHARS)}
        ariaLabel={t("activityStepsPanel.viewThinkingAria")}
        active={false}
        onClick={() =>
          onOpenDetail({
            kind: "thinking",
            toolCallId: "",
            toolName: "",
            title: t("activityStepsPanel.thinkingTitle"),
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
      active={activeDetail?.toolCallId === step.toolCallId}
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
 * Level 2 — a single step's detail. The back affordance lives in the panel
 * header (the chevron next to the step title). Thinking details render the
 * live reasoning markdown (`ThinkingDetailMarkdown`); tool details reuse the
 * shared `ToolDetailBody` (technical details + streaming output).
 */
function StepDetailLevel({
  detail,
  assistantId,
}: {
  detail: ToolDetailPayload;
  assistantId?: string | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      {detail.kind === "thinking" ? (
        <ThinkingDetailMarkdown detail={detail} assistantId={assistantId} />
      ) : (
        <ToolDetailBody
          detail={detail}
          source={TRANSCRIPT_TOOL_CALL_SOURCE}
          assistantId={assistantId}
        />
      )}
    </div>
  );
}
