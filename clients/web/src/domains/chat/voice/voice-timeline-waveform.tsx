/**
 * Voice-session timeline waveform: a dotted hairline baseline spanning the
 * full width, with a live amplitude-bar cluster drawn over a bounded segment
 * of the line (right of center). Presentational — the parent owns the voice
 * session and supplies an amplitude source.
 *
 * Rendering mirrors the composer's `StreamingWaveform` (dense 2×2px bars,
 * ~30 Hz sampling, right→left history, DPR-scaled canvas) but is a separate
 * component because the visual — dotted baseline + bounded bar segment — is
 * distinct from that component's full-width bar field.
 *
 * Amplitude is supplied via `getAmplitude` so the parent can poll a
 * store/analyser without re-rendering per sample. Colors resolve from CSS var
 * tokens at draw time so all themes (including runtime `data-theme` switches)
 * render correctly. Under reduced motion the component draws a single static,
 * amplitude-independent frame and never starts the animation loop.
 */

import { useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef } from "react";

import { cn } from "@vellumai/design-library";

// ---------------------------------------------------------------------------
// Visual constants — bar metrics match StreamingWaveform.
// ---------------------------------------------------------------------------
const BAR_W = 2; // px width of each amplitude bar
const BAR_GAP = 2; // px gap between bars
const STEP = BAR_W + BAR_GAP;
const MIN_BAR_H_PX = 2; // silent bars render as baseline dots
const MAX_H_RATIO = 0.85; // max bar is 85% of canvas height
const SAMPLE_MS = 33; // ~30 Hz sampling cadence

const DOT_SIZE = 1.5; // px square of each baseline dot
const DOT_STEP = 5; // px between dot starts
const SEGMENT_CENTER_RATIO = 0.7; // bar segment centers right of the midline
const SEGMENT_W = 120; // px width of the bar segment
const SEGMENT_W_COMPACT = 72; // narrower segment for the title-bar pill

// Fallbacks mirror the light-theme values in design-library tokens.css; they
// only apply when the CSS vars fail to resolve (e.g. headless tests).
const FALLBACK_LINE_COLOR = "#71808E";
const FALLBACK_BAR_COLOR = "#24292E";

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Deterministic, amplitude-independent bar heights for the static render. */
function staticBarLevel(index: number): number {
  return 0.2 + 0.6 * Math.abs(Math.sin((index + 1) * 2.4));
}

function resolveColors(): { line: string; bar: string } {
  const style = getComputedStyle(document.documentElement);
  return {
    line: style.getPropertyValue("--content-tertiary").trim() || FALLBACK_LINE_COLOR,
    bar: style.getPropertyValue("--content-default").trim() || FALLBACK_BAR_COLOR,
  };
}

/** Resize the backing store to CSS size × DPR and return the CSS-px size. */
function syncCanvasSize(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): { w: number; h: number } {
  const dpr = window.devicePixelRatio ?? 1;
  const w = canvas.offsetWidth;
  const h = canvas.offsetHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

/** Draw the dotted baseline plus the bar segment. */
function drawTimeline(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  segmentWidth: number,
  barLevelAt: (barIndex: number, numBars: number) => number,
): void {
  ctx.clearRect(0, 0, w, h);
  if (w <= 0 || h <= 0) {
    return;
  }

  const { line, bar } = resolveColors();
  const midY = h / 2;
  const segW = Math.min(segmentWidth, w);
  const segLeft = Math.min(Math.max(w * SEGMENT_CENTER_RATIO - segW / 2, 0), w - segW);

  // Dotted hairline across the full width, skipping the bar segment.
  ctx.fillStyle = line;
  for (let x = 0; x + DOT_SIZE <= w; x += DOT_STEP) {
    if (x >= segLeft - DOT_SIZE && x < segLeft + segW) {
      continue;
    }
    ctx.beginPath();
    ctx.roundRect(x, midY - DOT_SIZE / 2, DOT_SIZE, DOT_SIZE, DOT_SIZE / 2);
    ctx.fill();
  }

  // Amplitude bars over the segment; newest sample → rightmost bar.
  ctx.fillStyle = bar;
  const numBars = Math.floor(segW / STEP);
  const maxBarH = h * MAX_H_RATIO;
  for (let i = 0; i < numBars; i++) {
    const bh = Math.max(MIN_BAR_H_PX, barLevelAt(i, numBars) * maxBarH);
    ctx.beginPath();
    ctx.roundRect(segLeft + i * STEP, midY - bh / 2, BAR_W, bh, BAR_W / 2);
    ctx.fill();
  }
}

export interface VoiceTimelineWaveformProps {
  /**
   * Amplitude source (0–1), polled at ~30 Hz inside the draw loop so the
   * parent never re-renders per sample.
   */
  getAmplitude: () => number;
  /** While true new samples scroll in; when false the bars freeze in place. */
  active: boolean;
  /** Title-bar pill sizing: shorter canvas and a narrower bar segment. */
  compact?: boolean;
  className?: string;
}

export function VoiceTimelineWaveform({
  getAmplitude,
  active,
  compact = false,
  className,
}: VoiceTimelineWaveformProps) {
  const reducedMotion = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Refs let the rAF loop read the latest inputs without re-initializing.
  const getAmplitudeRef = useRef(getAmplitude);
  const activeRef = useRef(active);
  const samplesRef = useRef<number[]>([]);

  useLayoutEffect(() => {
    getAmplitudeRef.current = getAmplitude;
  }, [getAmplitude]);

  useLayoutEffect(() => {
    activeRef.current = active;
  }, [active]);

  const segmentWidth = compact ? SEGMENT_W_COMPACT : SEGMENT_W;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    if (reducedMotion) {
      // Static frame: dotted line + fixed bar cluster, no animation loop.
      const drawStatic = () => {
        const { w, h } = syncCanvasSize(canvas, ctx);
        drawTimeline(ctx, w, h, segmentWidth, staticBarLevel);
      };
      drawStatic();
      if (typeof ResizeObserver === "undefined") {
        return;
      }
      const observer = new ResizeObserver(drawStatic);
      observer.observe(canvas);
      return () => {
        observer.disconnect();
      };
    }

    let rafId: ReturnType<typeof requestAnimationFrame>;
    let lastSampleTs = 0;

    const tick = (ts: number) => {
      if (activeRef.current && ts - lastSampleTs >= SAMPLE_MS) {
        lastSampleTs = ts;
        samplesRef.current.push(clamp01(getAmplitudeRef.current()));
        const maxBars = Math.floor(segmentWidth / STEP);
        if (samplesRef.current.length > maxBars * 2) {
          samplesRef.current = samplesRef.current.slice(-maxBars);
        }
      }

      const { w, h } = syncCanvasSize(canvas, ctx);
      const samples = samplesRef.current;
      drawTimeline(ctx, w, h, segmentWidth, (i, numBars) => {
        const si = samples.length - numBars + i;
        return si >= 0 ? (samples[si] ?? 0) : 0;
      });

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [reducedMotion, segmentWidth]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      // width/height backing store is set by the draw code; CSS drives layout.
      className={cn("block w-full", compact ? "h-4" : "h-6", className)}
    />
  );
}
