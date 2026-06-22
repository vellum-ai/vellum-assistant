
import {
    ArrowDownToLine,
    ArrowUpFromLine,
    ChevronDown,
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

import { SubagentPhaseTimeline } from "@/domains/chat/components/subagent-phase-timeline";
import { computeSubagentCardData } from "@/domains/chat/hooks/use-subagent-card-data";

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
  }

  // Measure overflow against the collapsed clamp. While collapsed the clamp is
  // the source of truth, so `scrollHeight` exceeds `clientHeight` only when the
  // body is taller than the visible 3 lines. Skip measuring while expanded
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
        <Typography
          variant="title-medium"
          title={entry.label}
          className="min-w-0 shrink truncate text-[var(--content-default)]"
        >
          {entry.label}
        </Typography>
        <StatusBadge status={entry.status} />
        <span className="flex-1" />
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

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
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
                objectiveExpanded ? "" : "line-clamp-3"
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
      </div>
    </div>
  );
}
