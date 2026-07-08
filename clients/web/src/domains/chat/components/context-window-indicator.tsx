
import { Brain } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet, Button } from "@vellumai/design-library";

export interface ContextWindowUsage {
  tokens: number;
  maxTokens: number | null;
  fillRatio: number | null;
}

interface ContextWindowIndicatorProps {
  usage: ContextWindowUsage | null;
  assistantName: string | null;
  onClearContext?: () => void;
}

const RING_SIZE = 16;
const RING_STROKE = 2;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const HOVER_DELAY_MS = 200;
const TOOLTIP_GAP_PX = 8;

function resolveRingColor(ratio: number): string {
  if (ratio >= 0.8) {
    return "var(--system-negative-strong)";
  }
  if (ratio >= 0.6) {
    return "var(--system-mid-strong)";
  }
  // Neutral below the warning thresholds, matching macOS VContextWindowIndicator.
  // Not --system-positive-strong: velvet restyles that token to its pink accent.
  return "var(--content-tertiary)";
}

function formatTokens(count: number): string {
  if (count >= 1000) {
    return `${Math.round(count / 1000)}k`;
  }
  return `${count}`;
}

function CircularRing({
  ringColor,
  dashOffset,
  percentage,
}: {
  ringColor: string;
  dashOffset: number;
  percentage: number;
}) {
  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      role="img"
      aria-label={`Context window ${percentage}% full`}
      tabIndex={0}
      className="block outline-none focus-visible:ring-1 focus-visible:ring-[var(--primary-base)] rounded-full"
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        stroke="var(--content-tertiary)"
        strokeWidth={RING_STROKE}
        opacity={0.2}
      />
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        stroke={ringColor}
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={dashOffset}
        transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
        style={{ transition: "stroke-dashoffset 250ms ease-out, stroke 250ms ease-out" }}
      />
    </svg>
  );
}

function DesktopTooltipContent({
  percentage,
  ringColor,
  tokens,
  maxTokens,
  assistantDisplayName,
}: {
  percentage: number;
  ringColor: string;
  tokens: number;
  maxTokens: number | null;
  assistantDisplayName: string;
}) {
  return (
    <>
      <div className="text-body-small-default text-[var(--content-secondary)]">
        Context window:
      </div>
      <div
        className="text-body-medium-default"
        style={{ color: ringColor }}
      >
        {percentage}% full
      </div>
      {maxTokens != null && (
        <div className="text-body-small-default text-[var(--content-secondary)]">
          {formatTokens(tokens)} / {formatTokens(maxTokens)} tokens used
        </div>
      )}
      <div className="text-label-medium-default leading-tight text-[var(--content-tertiary)]">
        {assistantDisplayName} automatically
        <br />
        compacts its context.
      </div>
    </>
  );
}

function MobileSheetContent({
  percentage,
  ringColor,
  ratio,
  tokens,
  maxTokens,
  assistantDisplayName,
  onClearContext,
  onClose,
}: {
  percentage: number;
  ringColor: string;
  ratio: number;
  tokens: number;
  maxTokens: number | null;
  assistantDisplayName: string;
  onClearContext?: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="flex flex-col items-center gap-6">
        <span
          aria-hidden="true"
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-active)]"
        >
          <Brain className="h-7 w-7 text-[var(--primary-base)]" />
        </span>

        <BottomSheet.Title className="justify-center">Context Window</BottomSheet.Title>

        <div className="w-full px-2">
          <div className="relative h-4 w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--content-tertiary)_20%,transparent)]">
            <div
              className="h-full rounded-full transition-[width] duration-250 ease-out"
              style={{
                width: `${Math.round(ratio * 100)}%`,
                backgroundColor: ringColor,
              }}
            />
          </div>
        </div>

        <div className="flex flex-col items-center gap-2">
          <span className="text-body-large-default text-[var(--content-default)]">
            {percentage}% full
            {maxTokens != null && (
              <>
                {" "}
                <span className="text-[var(--content-tertiary)]">•</span>{" "}
                {formatTokens(tokens)} / {formatTokens(maxTokens)} tokens used
              </>
            )}
          </span>
          <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
            {assistantDisplayName} automatically compacts its context
          </span>
        </div>
      </div>

      {onClearContext && (
        <BottomSheet.Footer className="justify-center pt-6">
          <Button
            variant="outlined"
            fullWidth
            onClick={() => {
              onClearContext();
              onClose();
            }}
          >
            Clear Context
          </Button>
        </BottomSheet.Footer>
      )}
    </>
  );
}

export function ContextWindowIndicator({
  usage,
  assistantName,
  onClearContext,
}: ContextWindowIndicatorProps) {
  const assistantDisplayName = assistantName?.trim() || "Your assistant";
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<{ top: number; left: number } | null>(
    null,
  );
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current != null) {
        clearTimeout(hoverTimerRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (!isHovered || !triggerRef.current || !tooltipRef.current) {
      return;
    }
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const idealLeft = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
    const clampedLeft = Math.max(
      8,
      Math.min(idealLeft, viewportWidth - tooltipRect.width - 8),
    );
    const top = triggerRect.top - tooltipRect.height - TOOLTIP_GAP_PX;
    setTooltipPosition({ top, left: clampedLeft });
  }, [isHovered, usage]);

  if (!usage || usage.fillRatio == null) {
    return null;
  }

  const ratio = Math.min(Math.max(usage.fillRatio, 0), 1);
  const percentage = Math.round(ratio * 100);
  const ringColor = resolveRingColor(ratio);
  const dashOffset = RING_CIRCUMFERENCE * (1 - ratio);
  const { tokens, maxTokens } = usage;

  const handleMouseEnter = () => {
    if (isMobile) {
      return;
    }
    if (hoverTimerRef.current != null) {
      clearTimeout(hoverTimerRef.current);
    }
    hoverTimerRef.current = setTimeout(() => {
      setIsHovered(true);
    }, HOVER_DELAY_MS);
  };

  const handleMouseLeave = () => {
    if (hoverTimerRef.current != null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setIsHovered(false);
    setTooltipPosition(null);
  };

  if (isMobile) {
    return (
      <BottomSheet.Root open={sheetOpen} onOpenChange={setSheetOpen}>
        <BottomSheet.Trigger asChild>
          <button
            type="button"
            className="relative flex items-center px-1.5"
            aria-label={`Context window ${percentage}% full`}
          >
            <CircularRing
              ringColor={ringColor}
              dashOffset={dashOffset}
              percentage={percentage}
            />
          </button>
        </BottomSheet.Trigger>
        <BottomSheet.Content aria-describedby={undefined} className="max-h-[85dvh]">
          <BottomSheet.Header className="sr-only">
            <BottomSheet.Title>Context Window</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="px-2 pt-8 pb-8">
            <MobileSheetContent
              percentage={percentage}
              ringColor={ringColor}
              ratio={ratio}
              tokens={tokens}
              maxTokens={maxTokens}
              assistantDisplayName={assistantDisplayName}
              onClearContext={onClearContext}
              onClose={() => setSheetOpen(false)}
            />
          </BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }

  return (
    <div
      ref={triggerRef}
      className="relative flex items-center px-1.5"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleMouseEnter}
      onBlur={handleMouseLeave}
    >
      <CircularRing
        ringColor={ringColor}
        dashOffset={dashOffset}
        percentage={percentage}
      />
      {isHovered &&
        createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            className="fixed z-[9999] flex flex-col gap-2 rounded-[10px] bg-[var(--surface-lift)] p-3 text-left whitespace-nowrap pointer-events-none shadow-[var(--shadow-popover)]"
            style={{
              top: tooltipPosition?.top ?? -9999,
              left: tooltipPosition?.left ?? -9999,
              opacity: tooltipPosition ? 1 : 0,
            }}
          >
            <DesktopTooltipContent
              percentage={percentage}
              ringColor={ringColor}
              tokens={tokens}
              maxTokens={maxTokens}
              assistantDisplayName={assistantDisplayName}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
