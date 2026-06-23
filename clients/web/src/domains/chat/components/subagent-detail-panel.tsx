
import {
    ArrowDownToLine,
    ArrowUpFromLine,
    ChevronDown,
    ChevronLeft,
    DollarSign,
    Square,
    X,
} from "lucide-react";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { AvatarRenderer } from "@/components/avatar-renderer";
import {
    AnimatedMetricCard,
    formatNumber,
} from "@/domains/chat/components/metric-card";
import { StatusBadge } from "@/domains/chat/components/subagent-status-badge";
import type { SubagentEntry } from "@/domains/chat/subagent-store";
import { subagentTraits } from "@/utils/avatar-subagent";
import { isActiveStatus } from "@/utils/subagent-status";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";
import { Button, Typography } from "@vellumai/design-library";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { HeaderStepCarousel } from "@/domains/chat/components/tool-progress-card/header-step-carousel";
import { SubagentPhaseTimeline } from "@/domains/chat/components/subagent-phase-timeline";
import { ToolDetailBody } from "@/domains/chat/components/tool-detail-panel";
import { WebSearchDetailView } from "@/domains/chat/components/web-search/web-search-detail-view";
import {
    buildSubagentStepDetails,
    computeSubagentCardData,
} from "@/domains/chat/hooks/use-subagent-card-data";

/** Format a cost value (e.g. 0.68 -> "0.68"). */
function formatCost(cost: number): string {
  if (cost === 0) {
    return "0.00";
  }
  if (cost < 0.01) {
    return cost.toFixed(4);
  }
  return cost.toFixed(2);
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SubagentDetailPanelProps {
  entry: SubagentEntry;
  onClose: () => void;
  onStop?: (subagentId: string) => void;
  onRequestDetail?: (subagentId: string) => void;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SubagentDetailPanel({
  entry,
  onClose,
  onStop,
  onRequestDetail,
}: SubagentDetailPanelProps) {
  const isRunning = isActiveStatus(entry.status);
  const components = useBundledAvatarComponents();
  // Compute the avatar traits once per subagent instead of hashing the id
  // three separate times in the JSX below.
  const traits = useMemo(() => subagentTraits(entry.subagentId), [entry.subagentId]);
  // The panel re-renders when `entry` changes via the store subscription in
  // chat-content-layout.tsx, so memoizing on `entry` keeps the steps fresh.
  const cardData = useMemo(() => computeSubagentCardData(entry), [entry]);

  // `toolCallId`-keyed map of nested tool-detail payloads, used to swap the
  // panel body to a tool's input/output when its timeline pill is clicked —
  // without ever touching the global viewer-store / main view.
  //
  // Detail payloads for clickable timeline steps, keyed by the id a pill emits.
  // Tool steps key on their `toolUseId` (present for both live streaming events
  // and reloaded/history subagents hydrated via `onRequestDetail` from
  // `GET /subagents/:id`, which emits the tool id + raw input that
  // `mapDetailEvents` carries through); thinking/text steps key on the source
  // event id and carry the full, un-truncated reasoning. Steps with no entry
  // here render as non-clickable pills — a graceful fallback, not an error.
  const stepDetails = useMemo(() => buildSubagentStepDetails(entry), [entry]);

  // Which step's detail (if any) is shown nested inside this panel — the key
  // into `stepDetails` (a tool call or a thinking segment), or `null` to show
  // the timeline. Reset on subagent switch via the render-phase block below so
  // a detail opened for one subagent doesn't leak onto the next.
  const [selectedDetailKey, setSelectedDetailKey] = useState<string | null>(
    null,
  );

  // Which timeline groups are expanded. Lifted out of `SubagentPhaseTimeline`
  // so the expansion survives the timeline unmounting while a nested tool
  // detail is shown — returning via "Back" restores the same open group. Reset
  // on subagent switch via the render-phase block below.
  const [expandedSectionKeys, setExpandedSectionKeys] = useState<Set<string>>(
    new Set(),
  );

  // Objective collapse/expand. The toggle only appears when the clamped body
  // actually overflows, so short objectives show no affordance.
  const [objectiveExpanded, setObjectiveExpanded] = useState(false);
  const [objectiveOverflows, setObjectiveOverflows] = useState(false);
  const objectiveBodyRef = useRef<HTMLParagraphElement>(null);

  // Reset objective collapse state when the subagent changes. The desktop
  // parent reuses this instance across subagent switches (no `key`), so without
  // this an objective expanded for one subagent leaks onto the next — and since
  // the measurement effect below early-returns while `objectiveExpanded` is
  // true, the new (possibly short) objective would render stale-expanded with a
  // spurious "Show less" and never re-measure. Resetting during render (React's
  // "store previous prop" pattern) clears both flags before paint (no flash);
  // clearing `objectiveOverflows` lets the effect re-measure from a clean state.
  const [prevSubagentId, setPrevSubagentId] = useState(entry.subagentId);
  if (prevSubagentId !== entry.subagentId) {
    setPrevSubagentId(entry.subagentId);
    setObjectiveExpanded(false);
    setObjectiveOverflows(false);
    // Switching subagents returns the panel to the timeline view and clears
    // the previous subagent's expanded groups.
    setSelectedDetailKey(null);
    setExpandedSectionKeys(new Set());
  }

  // Measure overflow against the collapsed clamp. While collapsed the clamp is
  // the source of truth, so `scrollHeight` exceeds `clientHeight` only when the
  // body is taller than the visible 5 lines. Skip measuring while expanded
  // (the clamp is removed, which would otherwise report no overflow) so the
  // "Show less" affordance stays visible.
  //
  // Depend on `entry.subagentId` too: the render-phase reset above forces
  // `objectiveOverflows` to `false` on a subagent switch, so the effect must
  // re-run to recompute it. Without the id in the deps a switch between two
  // subagents whose objective text is byte-identical changes neither
  // `entry.objective` nor `objectiveExpanded`, the effect skips, and the
  // toggle would stay incorrectly hidden for an overflowing objective.
  useLayoutEffect(() => {
    if (objectiveExpanded) {
      return;
    }
    const node = objectiveBodyRef.current;
    if (!node) {
      return;
    }
    setObjectiveOverflows(node.scrollHeight > node.clientHeight);
  }, [entry.subagentId, entry.objective, objectiveExpanded]);

  useEffect(() => {
    if (onRequestDetail && entry.conversationId && entry.events.length === 0) {
      onRequestDetail(entry.subagentId);
    }
  }, [entry.subagentId, entry.conversationId, entry.events.length, onRequestDetail]);

  // The selected tool's nested payload, or `undefined` when nothing is selected
  // or the id has no payload (defensive — fall back to the timeline view).
  const activeDetail = selectedDetailKey
    ? stepDetails.get(selectedDetailKey)
    : undefined;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl bg-[var(--surface-lift)]">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-base)] px-5 py-4">
        {components ? (
          <AvatarRenderer
            components={components}
            bodyShapeId={traits.bodyShape}
            eyeStyleId={traits.eyeStyle}
            colorId={traits.color}
            size={32}
          />
        ) : (
          <div style={{ width: 32, height: 32, flexShrink: 0 }} aria-hidden />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <Typography
              variant="title-medium"
              title={entry.label}
              className="min-w-0 shrink truncate text-[var(--content-default)]"
            >
              {entry.label}
            </Typography>
            <StatusBadge status={entry.status} />
          </div>
          {/* Live "what the subagent is doing now" line — reuses the main-chat
              header carousel, fed by the same derived (title, info) the inline
              card uses. Hidden until there's at least one step (so an event-less
              spawn doesn't just echo the label) and while a nested step detail
              is open (the body is focused on one step, not the live latest). */}
          {cardData.steps.length > 0 && !activeDetail && (
            <HeaderStepCarousel
              currentStepTitle={cardData.currentStepTitle}
              currentStepInfo={cardData.currentStepInfo}
              bypassDwell={cardData.state !== "loading"}
            />
          )}
        </div>
        {isRunning && onStop && (
          <button
            type="button"
            aria-label="Stop subagent"
            onClick={() => onStop(entry.subagentId)}
            className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--system-negative-strong)] bg-transparent px-2.5 py-1.5 text-[var(--system-negative-strong)] transition-colors hover:bg-[var(--system-negative-weak)]"
          >
            <Square className="h-3 w-3" fill="currentColor" />
            <Typography variant="label-small-default">Stop</Typography>
          </button>
        )}
        <Button
          variant="outlined"
          iconOnly={<X />}
          onClick={onClose}
          aria-label="Close subagent detail"
          tooltip="Close"
          className="shrink-0 rounded-lg"
        />
      </div>

      {/* Scrollable body — swaps to a step's nested detail when one is selected,
          keeping the header above mounted in both views. */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {activeDetail ? (
          <>
            <button
              type="button"
              onClick={() => setSelectedDetailKey(null)}
              className="mb-4 flex cursor-pointer items-center gap-1.5 text-[var(--content-secondary)] transition-colors hover:text-[var(--content-default)]"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              <Typography variant="label-medium-default">Back</Typography>
            </button>
            {/* Thinking steps render their full reasoning markdown statically
                (subagent detail isn't a live chat-session source); web_search
                steps render their query + source links; tool steps use the
                shared technical-details/output body. */}
            {activeDetail.kind === "thinking" ? (
              <ChatMarkdownMessage
                content={activeDetail.thinkingText ?? ""}
                hardLineBreaks
              />
            ) : activeDetail.kind === "web_search" ? (
              <WebSearchDetailView detail={activeDetail} />
            ) : (
              <ToolDetailBody
                detail={activeDetail}
                showTechnicalDetailsLabel={false}
              />
            )}
          </>
        ) : (
          <>
            {/* Metrics row */}
            <div className="mb-5 grid grid-cols-3 gap-3">
              <AnimatedMetricCard
                icon={<ArrowDownToLine className="h-4 w-4 shrink-0" style={{ color: "var(--content-secondary)" }} />}
                target={entry.inputTokens}
                format={(n) => formatNumber(Math.round(n))}
                label="Input"
              />
              <AnimatedMetricCard
                icon={<ArrowUpFromLine className="h-4 w-4 shrink-0" style={{ color: "var(--content-secondary)" }} />}
                target={entry.outputTokens}
                format={(n) => formatNumber(Math.round(n))}
                label="Output"
              />
              <AnimatedMetricCard
                icon={<DollarSign className="h-4 w-4 shrink-0" style={{ color: "var(--content-secondary)" }} />}
                target={entry.totalCost}
                format={formatCost}
                label="Cost"
              />
            </div>

            {/* Objective section */}
            {entry.objective && (
              <div className="mb-5">
                <Typography
                  variant="body-medium-default"
                  as="h3"
                  className="mb-2 text-[var(--content-emphasised)]"
                >
                  Objective
                </Typography>
                <Typography
                  ref={objectiveBodyRef}
                  variant="body-medium-lighter"
                  as="p"
                  className={`whitespace-pre-wrap break-words leading-relaxed text-[var(--content-default)] ${
                    objectiveExpanded ? "" : "line-clamp-5"
                  }`}
                >
                  {entry.objective}
                </Typography>
                {objectiveOverflows && (
                  <button
                    type="button"
                    onClick={() => setObjectiveExpanded((prev) => !prev)}
                    className="mt-1.5 flex cursor-pointer items-center gap-1 text-[var(--content-secondary)] transition-colors hover:text-[var(--content-default)]"
                  >
                    <Typography variant="label-small-default">
                      {objectiveExpanded ? "Show less" : "Show more"}
                    </Typography>
                    <ChevronDown
                      className={`h-3.5 w-3.5 transition-transform ${
                        objectiveExpanded ? "rotate-180" : ""
                      }`}
                      aria-hidden
                    />
                  </button>
                )}
                <div className="mt-5 h-px w-full bg-[var(--border-hover)]" />
              </div>
            )}

            {/* Timeline section */}
            <div>
              <Typography
                variant="title-medium"
                as="h3"
                className="mb-4 text-[var(--content-emphasised)]"
              >
                Timeline
              </Typography>
              {/*
               * Key by subagent id so the timeline remounts on subagent switch,
               * resetting the expand/collapse state it holds. The drawer keeps this
               * component mounted across switches, so without a per-subagent reset
               * an expanded phase would leak its expanded state onto the next
               * subagent's same-positioned phase.
               */}
              {/*
               * Gate the empty state on the RAW `entry.events`, not on
               * `cardData.steps`. `computeSubagentCardData` can intentionally
               * DROP events (e.g. a `tool_result` with no preceding in-flight
               * `tool_call`), so `entry.events` can be non-empty while
               * `cardData.steps` is empty. Gating on steps would show a false
               * "No events yet" AND — because `entry.events.length !== 0` — the
               * detail-refetch effect above wouldn't fire to recover. When the
               * store has events we render the timeline (which returns null for
               * zero steps, an acceptable no-op).
               */}
              {entry.events.length > 0 ? (
                <SubagentPhaseTimeline
                  key={entry.subagentId}
                  steps={cardData.steps}
                  expandedKeys={expandedSectionKeys}
                  onExpandedKeysChange={setExpandedSectionKeys}
                  onStepDetailClick={(key) => {
                    if (stepDetails.has(key)) setSelectedDetailKey(key);
                  }}
                />
              ) : (
                <Typography
                  variant="body-small-default"
                  className="py-4 text-center text-[var(--content-tertiary)]"
                >
                  No events yet
                </Typography>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
