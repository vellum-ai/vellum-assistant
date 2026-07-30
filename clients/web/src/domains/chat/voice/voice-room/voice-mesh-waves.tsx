/**
 * Mesh waves — the "wireframe ribbon" alternative to the filled band.
 *
 * Where `voice-reactive-waves.tsx` draws three filled layers, this draws the
 * *same* signal as a woven surface: several dozen hairline curves, each one the
 * wave field sampled at a different depth. Neighbouring depths are phase-shifted
 * relative to one another, so the sheet twists and folds through itself, and
 * the crossings pile strokes on top of each other into bright ridges — the
 * oscilloscope-mesh look, where all the luminance is emergent rather than
 * painted.
 *
 * Canvas, not SVG. The filled band gets away with three `<path>` elements
 * because three `d` rewrites a frame is cheap; this needs 40+ polylines, and
 * rewriting that many path attributes every frame would thrash style and paint
 * for a purely decorative layer. On a canvas the whole sheet is one draw pass
 * with `globalCompositeOperation = "lighter"`, which is also what produces the
 * additive glow where lines converge — there is no blur or shadow anywhere in
 * here. `streaming-waveform.tsx` sets the same canvas precedent for the
 * dictation waveform.
 *
 * Audio drives the *envelope*, not the wave: the shared amplitude history
 * scales how far the sheet displaces at each x, so a loud syllable swells the
 * ribbon into a lobe that then travels left and flattens, while the underlying
 * ripple keeps its shape. That split is what keeps the look coherent — an
 * amplitude-driven ribbon still reads as one continuous surface, where
 * amplitude-driven *frequency* would read as noise.
 *
 * Positioning reuses the `voice-listening-waves--{placement}` rules, which are
 * placement-only (inset, height, the `--voice-amp` rise); the palette and style
 * rules target `path` and simply do not match a canvas, so the stroke color is
 * resolved from the same CSS custom properties in JS instead.
 */

import { useEffect, useRef } from "react";

import { createAmplitudeSmoother } from "./voice-motion";
import { createAmplitudeHistory } from "./voice-amplitude-history";
import type {
  VoiceWavePalette,
  VoiceWavePlacement,
} from "./voice-listening-waves";

/**
 * Depth lines in the sheet. The woven look needs enough of them that adjacent
 * curves read as a surface rather than as separate strokes; below ~30 it looks
 * like a stack of lines, and past ~60 the added density is invisible but the
 * per-frame cost is not.
 */
const LINES = 46;

/** Horizontal samples per line. Straight segments at this density read smooth. */
const SAMPLES = 96;

/** Samples of amplitude history retained, and how fast the terrain scrolls. */
const HISTORY_SIZE = 96;
const HISTORY_PERIOD_MS = 34;

/**
 * How far the sheet's near and far edges sit apart, as a fraction of the band
 * height. The sheet is thin relative to its displacement — that is what makes
 * it read as a ribbon seen nearly edge-on rather than as a landscape.
 */
const SHEET_SPREAD = 0.3;

/** Peak vertical displacement of the ribbon, as a fraction of the band height. */
const DISPLACE = 0.34;

/**
 * Phase offset between the near and far edges of the sheet, in radians. This is
 * the whole trick: at ~half a turn the far edge is riding the opposite part of
 * the wave from the near edge, so the sheet twists and the curves cross. At 0
 * they would move as one and the mesh would collapse into a single fat line.
 */
const DEPTH_PHASE = Math.PI * 1.7;

/** Idle displacement floor, so the sheet still breathes through silence. */
const IDLE_ENVELOPE = 0.13;

/** Fixed cyan for the `aurora` palette — matches the filled band's accent. */
const AURORA_HEX = "#22D3EE";

/**
 * Resolve a CSS color to `r,g,b` for use in `rgba()` strokes.
 *
 * Only the forms the avatar/tone tokens actually take need handling: hex (the
 * bundled avatar palette) and `rgb()` / `rgba()` (the tone tokens). Anything
 * else falls back rather than throwing — a decorative layer must never take the
 * room down.
 */
function toRgb(color: string, fallback: [number, number, number]): [number, number, number] {
  const value = color.trim();
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    const full =
      h.length === 3
        ? h
            .split("")
            .map((c) => c + c)
            .join("")
        : h;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }
  const rgb = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return [parts[0], parts[1], parts[2]];
    }
  }
  return fallback;
}

/** Stroke color for the sheet, read from the same tokens the band's CSS uses. */
function resolveStroke(
  node: HTMLElement,
  palette: VoiceWavePalette,
): [number, number, number] {
  const styles = getComputedStyle(node);
  if (palette === "aurora") {
    return toRgb(AURORA_HEX, [34, 211, 238]);
  }
  const token =
    palette === "accent"
      ? styles.getPropertyValue("--avatar-accent")
      : styles.getPropertyValue("--room-fg");
  return toRgb(token, palette === "accent" ? [99, 102, 241] : [255, 255, 255]);
}

export function VoiceMeshWaves({
  getAmplitude,
  palette = "aurora",
  placement = "bottom",
}: {
  /** Amplitude source (0–1), polled in a rAF loop. */
  getAmplitude: () => number;
  palette?: VoiceWavePalette;
  placement?: VoiceWavePlacement;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const getAmplitudeRef = useRef(getAmplitude);
  useEffect(() => {
    getAmplitudeRef.current = getAmplitude;
  }, [getAmplitude]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let stroke = resolveStroke(host, palette);

    // Backing store follows the element's CSS size × DPR; the context is scaled
    // so all drawing below is in CSS pixels and `lineWidth = 1` stays hairline.
    let width = 0;
    let height = 0;
    const resize = () => {
      const rect = host.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // The accent can change with the avatar; the observer is the cheapest
      // point to notice without subscribing to anything.
      stroke = resolveStroke(host, palette);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    const smoother = createAmplitudeSmoother({ attackMs: 80, releaseMs: 350 });
    const history = createAmplitudeHistory({
      size: HISTORY_SIZE,
      periodMs: HISTORY_PERIOD_MS,
    });
    const envelope = new Float32Array(HISTORY_SIZE);

    const draw = (timeSec: number) => {
      ctx.clearRect(0, 0, width, height);
      // Additive: where the folded sheet stacks strokes, the pile brightens.
      // This is the entire lighting model — no shadow, no blur.
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = 1;
      ctx.lineJoin = "round";

      // The sheet hangs from the middle of the band; placement CSS decides
      // where the band itself sits on screen.
      const centerY = height / 2;
      const spreadPx = height * SHEET_SPREAD;
      const displacePx = height * DISPLACE;
      const [r, g, b] = stroke;

      for (let line = 0; line < LINES; line++) {
        // 0 = far edge of the sheet, 1 = near edge.
        const depth = line / (LINES - 1);
        const baseY = centerY + (depth - 0.5) * spreadPx;
        const phase = timeSec * 0.9 + depth * DEPTH_PHASE;
        // Near lines read brighter, so the sheet has a front and a back
        // instead of looking like a flat stack.
        ctx.strokeStyle = `rgba(${r},${g},${b},${(0.07 + depth * 0.16).toFixed(3)})`;
        ctx.beginPath();

        for (let i = 0; i < SAMPLES; i++) {
          const u = i / (SAMPLES - 1);
          const x = u * width;
          // Envelope from the amplitude history: what was said, scrolling left.
          const amp =
            envelope[Math.min(HISTORY_SIZE - 1, Math.round(u * (HISTORY_SIZE - 1)))];
          const gain = IDLE_ENVELOPE + amp * (1 - IDLE_ENVELOPE);
          // Two ripples at different rates, counter-rotating through depth, so
          // the sheet interferes with itself rather than rippling uniformly.
          const wave =
            0.6 * Math.sin(u * Math.PI * 2 * 1.6 + phase) +
            0.4 * Math.sin(u * Math.PI * 2 * 2.7 - phase * 1.25);
          const y = baseY - gain * displacePx * wave;
          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }
    };

    // Reduced motion: draw the sheet once, at rest, and stop. The band's CSS
    // holds a steady low state for the same reason.
    if (reduce) {
      history.read(envelope, 3);
      draw(0);
      return () => observer.disconnect();
    }

    let raf = 0;
    let lastTime = performance.now();
    let lastAmpWritten = "";
    const tick = (now: number) => {
      const dt = Math.min(100, now - lastTime);
      lastTime = now;
      const target = Math.min(1, Math.max(0, getAmplitudeRef.current()));
      const amp = smoother.step(target, dt);

      // Keep publishing `--voice-amp`: the placement CSS reads it for the
      // band's rise and brightness, which composes over the canvas.
      const ampText = amp.toFixed(3);
      if (ampText !== lastAmpWritten) {
        lastAmpWritten = ampText;
        host.style.setProperty("--voice-amp", ampText);
      }

      history.push(amp, dt);
      history.read(envelope, 3);
      draw(now / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [palette]);

  const className = [
    "voice-listening-waves",
    "voice-listening-waves--mesh",
    `voice-listening-waves--${palette}`,
    `voice-listening-waves--${placement}`,
  ].join(" ");

  return (
    <div ref={hostRef} className={className} aria-hidden>
      <canvas
        ref={canvasRef}
        data-mesh-canvas=""
        className="absolute inset-0 h-full w-full"
      />
    </div>
  );
}
