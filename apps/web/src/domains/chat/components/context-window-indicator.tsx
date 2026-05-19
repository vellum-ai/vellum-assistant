
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useAppRootContainer } from "@/components/app-root-context.js";

export interface ContextWindowUsage {
  tokens: number;
  maxTokens: number | null;
  fillRatio: number | null;
}

interface ContextWindowIndicatorProps {
  usage: ContextWindowUsage | null;
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
  return "var(--content-tertiary)";
}

function formatTokens(count: number): string {
  if (count >= 1000) {
    return `${Math.round(count / 1000)}k`;
  }
  return `${count}`;
}

export function ContextWindowIndicator({ usage }: ContextWindowIndicatorProps) {
  const appRootContainer = useAppRootContainer();
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

  return (
    <div
      ref={triggerRef}
      className="relative flex items-center"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleMouseEnter}
      onBlur={handleMouseLeave}
    >
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
      {isHovered && appRootContainer &&
        createPortal(
          // Portal into the `.app-root` element so appTheme.css tokens like
          // `--surface-lift` resolve. `document.body` would render outside the
          // theme scope and the background would paint transparent.
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
              Vellum automatically
              <br />
              compacts its context.
            </div>
          </div>,
          appRootContainer,
        )}
    </div>
  );
}
