
import {
    ArrowDownToLine,
    ArrowUpFromLine,
    DollarSign,
    Square,
    X,
} from "lucide-react";

import { type ReactNode, useEffect, useRef, useState } from "react";

import { AvatarRenderer } from "@/components/avatar-renderer";
import { StatusBadge } from "@/domains/chat/components/subagent-status-badge";
import type { SubagentEntry } from "@/domains/chat/subagent-store";
import { subagentTraits } from "@/utils/avatar-subagent";
import { isActiveStatus } from "@/utils/subagent-status";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";
import { Button, Typography } from "@vellumai/design-library";

import { SubagentTimeline } from "@/domains/chat/components/subagent-timeline";

/** Format a number compactly (e.g. 257400 -> "257.4K"). */
function formatNumber(n: number): string {
  if (n >= 1_000_000) {
    const val = n / 1_000_000;
    return `${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const val = n / 1_000;
    return `${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)}K`;
  }
  return n.toLocaleString();
}

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

const ANIMATION_DURATION_MS = 300;

function useAnimatedNumber(target: number): number {
  const [displayed, setDisplayed] = useState(target);
  const rafRef = useRef<number>(0);
  const displayedRef = useRef(target);

  useEffect(() => {
    const from = displayedRef.current;
    if (from === target) return;

    cancelAnimationFrame(rafRef.current);
    const start = performance.now();

    const step = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / ANIMATION_DURATION_MS, 1);
      const eased = 1 - (1 - progress) ** 3;
      const value = from + (target - from) * eased;
      displayedRef.current = value;
      setDisplayed(value);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(step);
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target]);

  return displayed;
}

function MetricCard({
  icon,
  value,
  label,
}: {
  icon: ReactNode;
  value: string;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] px-3 py-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-base)]">
        {icon}
      </div>
      <div className="min-w-0">
        <Typography
          variant="title-small"
          className="block text-[var(--content-default)]"
        >
          {value}
        </Typography>
        <Typography
          variant="body-small-default"
          className="block text-[var(--content-secondary)]"
        >
          {label}
        </Typography>
      </div>
    </div>
  );
}

function AnimatedMetricCard({ icon, label, target, format }: {
  icon: ReactNode; label: string; target: number; format: (n: number) => string;
}) {
  const animated = useAnimatedNumber(target);
  return (
    <MetricCard
      icon={icon}
      label={label}
      value={format(animated)}
    />
  );
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
              className="whitespace-pre-wrap leading-relaxed text-[var(--content-default)]"
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
