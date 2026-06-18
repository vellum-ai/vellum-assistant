
import {
    ArrowDownToLine,
    ArrowUpFromLine,
    DollarSign,
    Square,
    X,
} from "lucide-react";

import {
  type ReactNode,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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

/** Read the user's reduced-motion preference, re-evaluating if it changes. */
function usePrefersReducedMotion(): boolean {
  const supported =
    typeof window !== "undefined" && typeof window.matchMedia === "function";
  const [reduced, setReduced] = useState(() =>
    supported
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  useEffect(() => {
    if (!supported) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [supported]);
  return reduced;
}

/**
 * Eases a displayed number toward `target`. A single rAF loop tracks a moving
 * target: when `target` changes mid-flight (frequent during streaming) we just
 * update the goal rather than cancelling and restarting a fresh tween on every
 * update, so the three metric counters never spawn overlapping rAF loops. The
 * loop self-terminates once it catches up, and snaps instantly when the user
 * prefers reduced motion.
 */
function useAnimatedNumber(target: number): number {
  const reduceMotion = usePrefersReducedMotion();
  const [displayed, setDisplayed] = useState(target);
  const displayedRef = useRef(target);
  const targetRef = useRef(target);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    targetRef.current = target;

    if (reduceMotion) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      displayedRef.current = target;
      setDisplayed(target);
      return;
    }

    // Already at the target, or a loop is already running toward the
    // (just-updated) target — nothing new to start.
    if (displayedRef.current === target || rafRef.current) return;

    const startTime = performance.now();
    const startValue = displayedRef.current;

    const step = (now: number) => {
      // Re-read the goal each frame so a target that changed mid-tween is
      // tracked without restarting the animation.
      const goal = targetRef.current;
      const progress = Math.min((now - startTime) / ANIMATION_DURATION_MS, 1);
      const eased = 1 - (1 - progress) ** 3;
      displayedRef.current =
        progress >= 1 ? goal : startValue + (goal - startValue) * eased;
      setDisplayed(displayedRef.current);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = 0;
      }
    };
    rafRef.current = requestAnimationFrame(step);
  }, [target, reduceMotion]);

  // Cancel any in-flight frame on unmount.
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

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
  // Compute the avatar traits once per subagent instead of hashing the id
  // three separate times in the JSX below.
  const traits = useMemo(() => subagentTraits(entry.subagentId), [entry.subagentId]);
  // Defer the timeline's events so heavy streaming updates render at low
  // priority (interruptible) and never block the panel-open animation or
  // input. The memoized SubagentTimeline bails out on the urgent pass.
  //
  // The deferred value carries the subagent id alongside the events. The
  // drawer stays mounted across subagent switches, so a bare deferred value
  // can lag and render the previous subagent's timeline under the new
  // subagent's header; when the deferred id doesn't match the current
  // subagent, fall back to live events so the timeline is never mismatched.
  const deferredInput = useMemo(
    () => ({ id: entry.subagentId, events: entry.events }),
    [entry.subagentId, entry.events],
  );
  const deferred = useDeferredValue(deferredInput);
  const timelineEvents =
    deferred.id === entry.subagentId ? deferred.events : entry.events;

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
          {/*
           * Key by subagent id so the timeline (which now owns lifted
           * expand/collapse state) remounts on subagent switch. Fetched
           * detail event ids are renumbered per subagent (detail-1, detail-2,
           * …) and the drawer keeps this component mounted across switches, so
           * without a per-subagent reset an expanded `detail-N` would leak its
           * expanded state onto the next subagent's `detail-N`.
           */}
          <SubagentTimeline key={entry.subagentId} events={timelineEvents} />
        </div>
      </div>
    </div>
  );
}
