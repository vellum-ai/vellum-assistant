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

import { useEffect, useMemo, useRef } from "react";

import { createAmplitudeSmoother } from "./voice-motion";
import { createAmplitudeHistory } from "./voice-amplitude-history";
import type {
  VoiceWavePalette,
  VoiceWavePlacement,
} from "./voice-listening-waves";

/**
 * The knobs that decide what the sheet looks like.
 *
 * These are exposed rather than baked in because the woven look is genuinely
 * sensitive to their ratios — `spread` vs `displace` in particular is the
 * difference between a folded ribbon and a flat stack of parallel lines — and
 * that is a judgement call best made by looking, not by reasoning. See the
 * `MESH_PRESETS` in the stories for the ones worth comparing.
 */
export interface VoiceMeshTuning {
  /**
   * Depth lines in the sheet. Enough that adjacent curves read as a surface
   * rather than as separate strokes; below ~30 it looks like a stack of lines,
   * and past ~90 the added density is invisible but the per-frame cost is not.
   */
  lines: number;
  /** Horizontal samples per line. Straight segments at this density read smooth. */
  samples: number;
  /**
   * How far the sheet's near and far edges sit apart, as a fraction of the band
   * height. Small values make the curves nearly coincide so they only separate
   * where the phase shift pulls them apart — that is what reads as a bundle of
   * filaments rather than as ruled lines.
   */
  spread: number;
  /** Peak vertical displacement, as a fraction of the band height. */
  displace: number;
  /**
   * Phase offset between the near and far edges of the sheet, in radians. The
   * whole trick: around half a turn the far edge rides the opposite part of the
   * wave from the near edge, so the sheet twists and the curves cross. At 0
   * they move as one and the mesh collapses into a single fat line.
   */
  depthPhase: number;
  /** Cycles across the band for the two ripples. Lower = broader lobes. */
  cyclesA: number;
  cyclesB: number;
  /** How fast the weave travels, in radians per second. */
  driftSpeed: number;
  /**
   * Speed of the second ripple as a fraction of the first. Both travel the
   * *same* direction — that is deliberate. Counter-propagating waves form a
   * standing pattern whose nodes oscillate around fixed centres, which is what
   * made the twists appear pinned to the same few spots. Same direction at
   * different speeds gives a beat that translates instead.
   */
  driftRatioB: number;
  /**
   * How strongly the amplitude history warps the weave's phase along x.
   *
   * Phase accumulates as a running total of the envelope, so where the voice
   * was loud the phase advances faster and the weave bunches tighter. That
   * makes the twists land where the speech was — and because the history
   * scrolls left, they travel with it. Without this, the audio only scales the
   * sheet's height and the *structure* is a fixed formula, which is what reads
   * as static however much the sheet swells.
   */
  swirl: number;
  /**
   * Amplitude and rate of a slow phase wander applied to each ripple.
   *
   * Belt and braces for silence: with no audio there is no swirl, so this keeps
   * the interference pattern sliding rather than settling into one pose. Two
   * incommensurate rates, so it does not visibly loop.
   */
  wander: number;
  wanderHzA: number;
  wanderHzB: number;
  /** Stroke alpha at the far and near edges — the sheet's depth cue. */
  alphaFar: number;
  alphaNear: number;
  /** Displacement floor, so the sheet still breathes through silence. */
  idleEnvelope: number;
  /**
   * How fast the band reaches its opacity ceiling as amplitude rises.
   *
   * Opacity and displacement both used to scale linearly with amplitude, which
   * multiplied out: at half volume the sheet was half as tall *and* half as
   * visible, so presence fell off with the square of the signal and ordinary
   * speech — which rarely holds near full amplitude — barely registered.
   * Displacement is what should carry dynamics; opacity only has to say that a
   * voice is present, so it saturates at `1 / opacityKnee` of full amplitude
   * and stays there. Still reaches zero in silence.
   */
  opacityKnee: number;
  /** Samples of amplitude history retained, and how fast the terrain scrolls. */
  historySize: number;
  historyPeriodMs: number;
}

/**
 * The "filament" tuning: many lines at low alpha with the sheet's near and far
 * edges almost coincident, so the curves separate only where the twist pulls
 * them apart. That is what reads as a bundle of filaments rather than as ruled
 * lines at different heights — the earlier 46-line/0.3-spread tuning looked
 * like a stack before it looked like one folded surface.
 *
 * `idleEnvelope` is 0 on purpose: displacement is now proportional to
 * amplitude with no floor under it, so the sheet flattens as the voice stops
 * instead of holding a resting breath. The band's opacity fades out over the
 * same signal (see `--band-peak-opacity` in `index.css`), so silence leaves
 * nothing on screen rather than an idling decoration.
 */
export const DEFAULT_MESH_TUNING: VoiceMeshTuning = {
  lines: 92,
  samples: 96,
  spread: 0.06,
  displace: 0.42,
  depthPhase: Math.PI * 1.7,
  cyclesA: 1.6,
  cyclesB: 2.7,
  driftSpeed: 0.9,
  driftRatioB: 0.55,
  swirl: 5.5,
  wander: 0.9,
  wanderHzA: 0.037,
  wanderHzB: 0.023,
  alphaFar: 0.08,
  alphaNear: 0.42,
  idleEnvelope: 0,
  opacityKnee: 3,
  historySize: 96,
  historyPeriodMs: 34,
};

/**
 * Strip-height override for the inline surfaces (the composer's voice bar).
 *
 * The room gives the sheet hundreds of pixels; the composer strip gives it
 * about 24. At the room's 92 lines that is a quarter-pixel of separation each,
 * so the weave collapses into a solid smear and every line's individual alpha
 * stacks into a flat block. Fewer lines with more separation and more alpha
 * each keeps it legible as a woven ribbon at strip height — the same
 * accommodation `WAVE_LAYERS_INLINE` makes for the filled band.
 */
export const MESH_INLINE_TUNING: Partial<VoiceMeshTuning> = {
  lines: 26,
  spread: 0.18,
  displace: 0.62,
  alphaFar: 0.16,
  alphaNear: 0.6,
};

/**
 * The sheet's normalized vertical displacement at one point, in roughly −1..1.
 *
 * Pure and exported so the weave's behaviour can be tested directly rather than
 * by rendering seconds of canvas: the property that matters — that the pinches
 * where depth lines converge *travel* rather than sit in fixed spots — is only
 * visible when averaged over ten-odd seconds, which is not something a
 * component test can afford to wait for.
 *
 * `swirl` is the phase already accumulated from the amplitude history up to
 * this x (see {@link VoiceMeshTuning.swirl}); the caller computes it once per
 * frame for the whole band rather than per line.
 */
export function meshDisplacement(
  u: number,
  depth: number,
  timeSec: number,
  swirl: number,
  config: VoiceMeshTuning,
): number {
  const phase = timeSec * config.driftSpeed + depth * config.depthPhase;
  const wanderA =
    config.wander * Math.sin(timeSec * config.wanderHzA * Math.PI * 2);
  const wanderB =
    config.wander * Math.sin(timeSec * config.wanderHzB * Math.PI * 2 + 1.9);
  // Both ripples travel the same direction at different speeds, so their beat
  // — and every pinch in it — translates across the band. Counter-propagating
  // them (the first cut) made a standing pattern whose nodes only oscillated
  // around fixed centres, which is what read as static.
  return (
    0.6 *
      Math.sin(u * Math.PI * 2 * config.cyclesA + phase + swirl + wanderA) +
    0.4 *
      Math.sin(
        u * Math.PI * 2 * config.cyclesB +
          phase * config.driftRatioB +
          swirl * 1.6 +
          wanderB,
      )
  );
}

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
  color?: string,
): [number, number, number] {
  if (color) {
    return toRgb(color, [255, 255, 255]);
  }
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

/**
 * Which compositing mode the sheet's overlapping strokes accumulate under.
 *
 * This is not a style preference — it is forced by the ink. `lighter` is
 * additive, so it can only ever brighten what is already on the canvas: a
 * black stroke contributes zero and the entire sheet renders invisible. Dark
 * ink therefore has to composite normally, where each stroke's alpha pulls the
 * pixel further toward the stroke color. Overlaps still accumulate either way,
 * which is what keeps the woven ridges emergent rather than painted — they
 * just accumulate toward white in one mode and toward black in the other.
 *
 * Chosen from perceived luminance rather than exposed as a knob, because
 * getting it wrong does not look worse, it looks like nothing at all.
 */
function compositeFor(stroke: [number, number, number]): GlobalCompositeOperation {
  const [r, g, b] = stroke;
  // Rec. 601 luma, which is close enough for a light/dark decision.
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma >= 0.5 ? "lighter" : "source-over";
}

export function VoiceMeshWaves({
  getAmplitude,
  palette = "aurora",
  placement = "bottom",
  color,
  peakOpacity = 1,
  tuning,
}: {
  /** Amplitude source (0–1), polled in a rAF loop. */
  getAmplitude: () => number;
  palette?: VoiceWavePalette;
  placement?: VoiceWavePlacement;
  /**
   * Explicit stroke color, overriding `palette`. The room uses this to tell
   * the two voices apart by ink instead of by position — see `BAND_VOICE`.
   * Compositing follows the color's luminance automatically.
   */
  color?: string;
  /**
   * Band opacity at full amplitude. Opacity scales linearly from 0, so the
   * sheet fades out entirely as the voice stops rather than settling to a
   * resting visibility.
   */
  peakOpacity?: number;
  /** Overrides on {@link DEFAULT_MESH_TUNING}. */
  tuning?: Partial<VoiceMeshTuning>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const getAmplitudeRef = useRef(getAmplitude);
  useEffect(() => {
    getAmplitudeRef.current = getAmplitude;
  }, [getAmplitude]);

  // Serialized, so a caller passing a fresh object literal every render does
  // not tear down and restart the draw loop 60 times a second.
  const tuningKey = JSON.stringify(tuning ?? {});
  const config = useMemo(
    () => ({ ...DEFAULT_MESH_TUNING, ...(JSON.parse(tuningKey) as Partial<VoiceMeshTuning>) }),
    [tuningKey],
  );

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
    let stroke = resolveStroke(host, palette, color);
    let composite = compositeFor(stroke);

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
      stroke = resolveStroke(host, palette, color);
      composite = compositeFor(stroke);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    const smoother = createAmplitudeSmoother({ attackMs: 80, releaseMs: 350 });
    const history = createAmplitudeHistory({
      size: config.historySize,
      periodMs: config.historyPeriodMs,
    });
    const envelope = new Float32Array(config.historySize);
    // Phase warp accumulated along x from the envelope — see `swirl`. Held
    // alongside the envelope so it is rebuilt once per frame, not per line.
    const warp = new Float32Array(config.historySize);

    const draw = (timeSec: number) => {
      ctx.clearRect(0, 0, width, height);
      // Where the folded sheet stacks strokes, the pile accumulates — toward
      // white under `lighter`, toward the ink under `source-over`. That is the
      // entire lighting model; there is no shadow or blur anywhere in here.
      ctx.globalCompositeOperation = composite;
      ctx.lineWidth = 1;
      ctx.lineJoin = "round";

      // The sheet hangs from the middle of the band; placement CSS decides
      // where the band itself sits on screen.
      const centerY = height / 2;
      const spreadPx = height * config.spread;
      const displacePx = height * config.displace;
      const alphaSpan = config.alphaNear - config.alphaFar;
      const lastSample = config.historySize - 1;
      // Running total of the envelope, normalized to its own length so `swirl`
      // means the same thing whatever the history size: loud stretches advance
      // the phase faster, so the weave bunches where the voice was.
      let running = 0;
      for (let i = 0; i < config.historySize; i++) {
        running += envelope[i];
        warp[i] = (running / config.historySize) * config.swirl;
      }
      const [r, g, b] = stroke;

      for (let line = 0; line < config.lines; line++) {
        // 0 = far edge of the sheet, 1 = near edge.
        const depth = config.lines > 1 ? line / (config.lines - 1) : 0.5;
        const baseY = centerY + (depth - 0.5) * spreadPx;
        // Near lines read brighter, so the sheet has a front and a back
        // instead of looking like a flat stack.
        ctx.strokeStyle = `rgba(${r},${g},${b},${(config.alphaFar + depth * alphaSpan).toFixed(3)})`;
        ctx.beginPath();

        for (let i = 0; i < config.samples; i++) {
          const u = i / (config.samples - 1);
          const x = u * width;
          // Envelope from the amplitude history: what was said, scrolling left.
          const sample = Math.min(lastSample, Math.round(u * lastSample));
          const amp = envelope[sample];
          const gain = config.idleEnvelope + amp * (1 - config.idleEnvelope);
          // Phase warp from what was said up to this point along the band.
          const wave = meshDisplacement(
            u,
            depth,
            timeSec,
            warp[sample],
            config,
          );
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

      // `--voice-amp` stays for the shared placement CSS; `--band-presence` is
      // the saturating curve the mesh's own opacity rides (see `opacityKnee`).
      const ampText = amp.toFixed(3);
      if (ampText !== lastAmpWritten) {
        lastAmpWritten = ampText;
        host.style.setProperty("--voice-amp", ampText);
        host.style.setProperty(
          "--band-presence",
          Math.min(1, amp * config.opacityKnee).toFixed(3),
        );
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
  }, [palette, color, config]);

  const className = [
    "voice-listening-waves",
    "voice-listening-waves--mesh",
    `voice-listening-waves--${palette}`,
    `voice-listening-waves--${placement}`,
  ].join(" ");

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ ["--band-peak-opacity" as string]: peakOpacity }}
      aria-hidden
    >
      <canvas
        ref={canvasRef}
        data-mesh-canvas=""
        className="absolute inset-0 h-full w-full"
      />
    </div>
  );
}
