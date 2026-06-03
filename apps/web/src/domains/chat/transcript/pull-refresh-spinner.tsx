
import { useEffect, useState } from "react";

import { PULL_THRESHOLD_PX } from "@/domains/chat/transcript/pull-to-refresh-utils";
import type { PullPhase } from "@/domains/chat/transcript/use-pull-to-refresh";

interface PullRefreshSpinnerProps {
  /** Visual height of the spinner element in px. Drives the
   *  flex-item height of this container, which (rendered last inside
   *  the flex-col parent) shows up as growing space at the visual
   *  bottom of the transcript. */
  height: number;
  /** Drag progress, 0..1, where 1 is the commit threshold. */
  progress: number;
  phase: PullPhase;
}

const SVG_SIZE = 24;
const STROKE = 2;
const RADIUS = (SVG_SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function usePrefersReducedMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduceMotion;
}

export function PullRefreshSpinner({
  height,
  progress,
  phase,
}: PullRefreshSpinnerProps) {
  const reduceMotion = usePrefersReducedMotion();

  // Only animate height transitions when not actively dragging — the
  // drag itself must follow the finger 1:1, but the snap-back to 0
  // (after a sub-threshold release) and the lock-in to the refreshing
  // height should be a smooth ease-out.
  const animateHeight = phase !== "dragging";

  // The progress dial fills counter-clockwise from the top as drag
  // progresses. Once refreshing, we hide the dial and show an
  // indeterminate spinner.
  const dialOffset = CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, progress)));
  const opacity = phase === "refreshing"
    ? 1
    : Math.min(1, height / PULL_THRESHOLD_PX);

  return (
    <div
      data-testid="pull-refresh-spinner"
      aria-hidden={phase !== "refreshing"}
      style={{
        height: `${Math.max(0, height)}px`,
        transitionProperty: animateHeight ? "height" : "none",
        transitionDuration: reduceMotion ? "0ms" : "180ms",
        transitionTimingFunction: "ease-out",
      }}
      className="pointer-events-none flex w-full shrink-0 items-center justify-center overflow-hidden"
    >
      <div
        className="flex items-center justify-center"
        style={{
          opacity,
          transitionProperty: reduceMotion || phase === "dragging"
            ? "none"
            : "opacity",
          transitionDuration: reduceMotion ? "0ms" : "180ms",
        }}
      >
        {phase === "refreshing" ? (
          <svg
            width={SVG_SIZE}
            height={SVG_SIZE}
            viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
            className={reduceMotion ? undefined : "animate-spin"}
            role="status"
            aria-label="Refreshing"
          >
            <circle
              cx={SVG_SIZE / 2}
              cy={SVG_SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={STROKE}
              strokeOpacity={0.2}
            />
            <circle
              cx={SVG_SIZE / 2}
              cy={SVG_SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * 0.75}
            />
          </svg>
        ) : (
          <svg
            width={SVG_SIZE}
            height={SVG_SIZE}
            viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
            style={{
              transform: "rotate(-90deg)",
              color: "var(--content-tertiary)",
            }}
            aria-hidden="true"
          >
            <circle
              cx={SVG_SIZE / 2}
              cy={SVG_SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={STROKE}
              strokeOpacity={0.2}
            />
            <circle
              cx={SVG_SIZE / 2}
              cy={SVG_SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={dialOffset}
            />
          </svg>
        )}
      </div>
    </div>
  );
}
