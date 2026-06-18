
import {
    ArrowDownToLine,
    ArrowUpFromLine,
    DollarSign,
    Square,
    X,
} from "lucide-react";

import { useEffect } from "react";

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

import { SubagentTimeline } from "@/domains/chat/components/subagent-timeline";

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
            bodyShapeId={subagentTraits(entry.subagentId).bodyShape}
            eyeStyleId={subagentTraits(entry.subagentId).eyeStyle}
            colorId={subagentTraits(entry.subagentId).color}
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
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--system-negative-strong)] px-3 py-1.5 text-white transition-colors hover:bg-[color-mix(in_srgb,var(--system-negative-strong)_85%,black)]"
          >
            <Square className="h-3 w-3" fill="currentColor" />
            <Typography variant="label-small-default" className="text-white">
              Stop
            </Typography>
          </button>
        )}
        <Button
          variant="ghost"
          iconOnly={<X />}
          onClick={onClose}
          aria-label="Close subagent detail"
          tooltip="Close"
          className="shrink-0"
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
          <div className="mb-5 rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] px-4 py-3">
            <Typography
              variant="body-medium-default"
              as="h3"
              className="mb-2 text-[var(--content-emphasised)]"
            >
              Objective
            </Typography>
            <Typography
              variant="body-medium-lighter"
              as="p"
              className="whitespace-pre-wrap break-words leading-relaxed text-[var(--content-default)]"
            >
              {entry.objective}
            </Typography>
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
          <SubagentTimeline events={entry.events} />
        </div>
      </div>
    </div>
  );
}
