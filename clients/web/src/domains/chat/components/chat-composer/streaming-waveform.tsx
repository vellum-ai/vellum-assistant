
import { useEffect, useLayoutEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Visual constants — mirror macOS VStreamingWaveform (.scrolling style).
// ---------------------------------------------------------------------------
const BAR_W = 2;          // px width of each bar
const BAR_GAP = 2;        // px gap between bars
const STEP = BAR_W + BAR_GAP;
const MIN_H_PX = 2;       // minimum bar height (baseline dot), matches lineWidth on macOS
const MAX_H_RATIO = 0.85; // max bar is 85% of container height (macOS: maxBarHeight = 0.85 * frame)
const SAMPLE_MS = 33;     // ~30 Hz — matches macOS amplitudeSubject cadence

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Full-width scrolling amplitude waveform.
 *
 * Mirrors the macOS `VStreamingWaveform` component with `.scrolling` style:
 * - Dense 2×2px bars spanning the full container width.
 * - Amplitude history builds right→left; oldest sample on the left.
 * - Baseline bars render as 2px dots (amplitude = 0) and grow proportionally.
 * - Rendered via `<canvas>` for smooth 30 Hz updates without React overhead.
 *
 * When `paused` is true the rAF loop stops appending new samples and the
 * canvas dims to ~60% opacity. The trailing samples from the recording stay
 * visible as a frozen waveform — the visual signal that the recording was
 * captured and the system is now transcribing it. Pair with a "Transcribing…"
 * caption below the waveform.
 */
export function StreamingWaveform({
  amplitude,
  paused = false,
}: {
  amplitude: number;
  paused?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Keep a ref to the latest amplitude so the rAF loop always reads the
  // current value without being re-initialized every time it changes.
  const ampRef = useRef(amplitude);
  const pausedRef = useRef(paused);
  const samplesRef = useRef<number[]>([]);

  useLayoutEffect(() => {
    ampRef.current = amplitude;
  }, [amplitude]);

  useLayoutEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Resolve --content-tertiary once. It's a plain hex in appTheme.css so
    // canvas can consume it directly as fillStyle.
    const resolvedColor =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--content-tertiary")
        .trim() || "#71808E";

    const ctx = canvas.getContext("2d")!;

    let rafId: ReturnType<typeof requestAnimationFrame>;
    let lastSampleTs = 0;

    function tick(ts: number) {
      if (!canvas) return;

      if (!pausedRef.current && ts - lastSampleTs >= SAMPLE_MS) {
        lastSampleTs = ts;
        samplesRef.current.push(ampRef.current);
        const maxVisible = Math.ceil(canvas.offsetWidth / STEP) + 2;
        if (samplesRef.current.length > maxVisible * 2) {
          samplesRef.current = samplesRef.current.slice(-maxVisible);
        }
      }

      const dpr = window.devicePixelRatio ?? 1;
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = resolvedColor;

      const numBars = Math.floor(w / STEP);
      const samples = samplesRef.current;
      const maxBarH = h * MAX_H_RATIO;

      for (let i = 0; i < numBars; i++) {
        // Map bar index to sample: newest sample → rightmost bar.
        const si = samples.length - numBars + i;
        const amp = si >= 0 ? (samples[si] ?? 0) : 0;
        const bh = Math.max(MIN_H_PX, amp * maxBarH);
        const x = i * STEP;
        const y = (h - bh) / 2;

        ctx.beginPath();
        ctx.roundRect(x, y, BAR_W, bh, BAR_W / 2);
        ctx.fill();
      }

      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      // width/height are set by the rAF loop; CSS drives the layout size.
      style={{
        display: "block",
        width: "100%",
        height: "32px",
        opacity: paused ? 0.6 : 1,
        transition: "opacity 200ms ease-out",
      }}
    />
  );
}
