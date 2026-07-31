/**
 * Signal-driven listening waves — the reactive replacement for the fixed sine
 * geometry in `voice-listening-waves.tsx`.
 *
 * The original band authors three sine paths *once at mount* from constant
 * amplitudes and cycle counts, then slides them sideways with a CSS keyframe.
 * Live amplitude only reaches `translateY` / `opacity` on the whole layer, so
 * the silhouette itself is frozen: the band reads as a picture on a conveyor
 * belt, not as a voice. That is the "looks like a PNG" complaint, precisely.
 *
 * Here the geometry *is* the signal. Each layer keeps a rolling history of the
 * amplitude it has been fed and rebuilds its path every frame from that
 * history, so the terrain is a scrolling record of what was actually said: a
 * loud syllable raises a crest that then travels left and decays off the edge,
 * and silence flattens the band within a second. Nothing is pre-authored, so
 * nothing can look pre-rendered.
 *
 * Depth comes from the history itself rather than from parallax speeds: each
 * layer samples at its own cadence (back slow and broad, front fast and
 * crisp), so the same speech writes a wide swell behind and a tight ripple in
 * front. Because the layers scroll by regenerating geometry, the CSS drift
 * keyframe is switched off (`--reactive`); leaving it on would double the
 * motion.
 *
 * Rendering discipline matches the rest of the voice surfaces: amplitude is
 * polled inside a rAF loop and written straight to the DOM (`setAttribute` on
 * the path, `--voice-amp` on the container) — never through React state, which
 * would re-render the tree 60 times a second.
 *
 * The container reuses `voice-listening-waves`' class names, so every existing
 * palette (`aurora` / `accent` / `tone`), style (`fill` / `line`), and
 * placement (`top` / `bottom` / `center` / `inline`) applies unchanged. The two
 * components are prop-compatible: swapping one for the other is an import
 * change.
 */

import { useEffect, useRef } from "react";

import { createAmplitudeSmoother } from "./voice-motion";
import { createAmplitudeHistory } from "./voice-amplitude-history";
import type {
  VoiceWavePalette,
  VoiceWavePlacement,
  VoiceWaveStyle,
} from "./voice-listening-waves";

// Same authored viewBox as the sine band, so the placement/palette CSS (which
// assumes a fill closing to `VIEW_H`) applies without change. Unlike the sine
// band the path spans exactly one viewBox width: there is no CSS drift to tile
// against, because the history scroll supplies the horizontal motion.
const VIEW_W = 1200;
const VIEW_H = 200;

/**
 * Samples retained per layer. Each becomes one spline knot, so this is both
 * the horizontal resolution of the terrain and (with the layer's cadence) how
 * many seconds of speech stay on screen. 64 keeps the per-frame path string
 * small enough that three layers cost well under a millisecond.
 */
const HISTORY = 64;

/**
 * Per-layer character. `periodMs` is how often the layer takes a sample, which
 * sets both its scroll speed and its time window: the back layer samples
 * slowly, so its history spans ~4s of speech as broad hills, while the front
 * layer spans ~1.4s as a tight ripple. `gain` is the crest height as a
 * fraction of the viewBox; `smooth` is a moving-average width in samples
 * (wider = rounder hills); `sway` is the idle breathing amplitude that keeps
 * the band alive through silence.
 */
interface ReactiveWaveLayer {
  modifier: "back" | "mid" | "front";
  periodMs: number;
  gain: number;
  smooth: number;
  sway: number;
  swayHz: number;
  swayPhase: number;
}

const WAVE_LAYERS: ReactiveWaveLayer[] = [
  {
    modifier: "back",
    periodMs: 62,
    gain: 0.42,
    smooth: 5,
    sway: 0.05,
    swayHz: 0.05,
    swayPhase: 0,
  },
  {
    modifier: "mid",
    periodMs: 40,
    gain: 0.54,
    smooth: 3,
    sway: 0.038,
    swayHz: 0.08,
    swayPhase: 1.1,
  },
  {
    modifier: "front",
    periodMs: 24,
    gain: 0.36,
    smooth: 2,
    sway: 0.028,
    swayHz: 0.13,
    swayPhase: 2.3,
  },
];

/**
 * Inline strips (the composer bar, the title-bar pill) squeeze the 200-unit
 * viewBox into ~24 px, which flattens the room's crests into hairlines. Same
 * cadences and character — only the gains and sway are steepened so the
 * ripple stays legible at strip height, mirroring what `WAVE_LAYERS_INLINE`
 * does for the sine band.
 */
const WAVE_LAYERS_INLINE: ReactiveWaveLayer[] = WAVE_LAYERS.map((layer) => ({
  ...layer,
  gain: layer.gain * 1.6,
  sway: layer.sway * 1.5,
}));

/**
 * Turn a layer's smoothed history (already in `out`, oldest-first) into
 * viewBox y-coordinates, adding the layer's idle sway.
 *
 * The sway is added rather than blended so speech always stacks on top of the
 * resting breath: at silence the band is a slow swell, and a loud syllable
 * still reads as a crest above it. Its phase advances with `timeSec` and
 * varies along x, so the resting state drifts instead of standing still.
 */
function toViewBoxY(
  layer: ReactiveWaveLayer,
  timeSec: number,
  out: Float32Array,
): void {
  for (let i = 0; i < HISTORY; i++) {
    const sway =
      layer.sway *
      (0.5 +
        0.5 *
          Math.sin(
            timeSec * layer.swayHz * 2 * Math.PI +
              layer.swayPhase +
              (i / HISTORY) * Math.PI * 2,
          ));
    out[i] = VIEW_H - (out[i] * layer.gain + sway) * VIEW_H;
  }
}

/**
 * Build a smooth path through the sampled heights.
 *
 * The knots are joined with a Catmull-Rom spline converted to cubic Béziers,
 * which turns the sampled staircase into rolling hills without the overshoot a
 * naive smoothing would give on a sharp consonant. `fill` closes the curve
 * down to the viewBox floor (the "water" look the palettes fill); `line`
 * leaves it open to be stroked.
 */
function buildPath(ys: Float32Array, style: VoiceWaveStyle): string {
  const step = VIEW_W / (HISTORY - 1);
  const x = (i: number) => i * step;
  const y = (i: number) => ys[Math.min(HISTORY - 1, Math.max(0, i))];

  let d = `M0,${y(0).toFixed(1)}`;
  for (let i = 0; i < HISTORY - 1; i++) {
    const y0 = y(i - 1);
    const y1 = y(i);
    const y2 = y(i + 1);
    const y3 = y(i + 2);
    const c1x = x(i) + step / 3;
    const c1y = y1 + (y2 - y0) / 6;
    const c2x = x(i + 1) - step / 3;
    const c2y = y2 - (y3 - y1) / 6;
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${x(i + 1).toFixed(1)},${y2.toFixed(1)}`;
  }
  if (style === "fill") {
    d += `L${VIEW_W},${VIEW_H}L0,${VIEW_H}Z`;
  }
  return d;
}

export function VoiceReactiveWaves({
  getAmplitude,
  waveStyle = "fill",
  palette = "aurora",
  placement = "bottom",
}: {
  /** Amplitude source (0–1), polled in a rAF loop — mic while listening, TTS output while responding. */
  getAmplitude: () => number;
  waveStyle?: VoiceWaveStyle;
  palette?: VoiceWavePalette;
  placement?: VoiceWavePlacement;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const getAmplitudeRef = useRef(getAmplitude);
  useEffect(() => {
    getAmplitudeRef.current = getAmplitude;
  }, [getAmplitude]);

  const inline = placement === "inline";
  const layers = inline ? WAVE_LAYERS_INLINE : WAVE_LAYERS;

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    // Honour the OS setting the same way the sine band does: the CSS holds a
    // steady low band under `prefers-reduced-motion`, so skip the loop
    // entirely rather than animating geometry nobody asked to see.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const paths = Array.from(
      node.querySelectorAll<SVGPathElement>("path[data-reactive-wave]"),
    );
    if (paths.length === 0) {
      return;
    }

    // Same VU ballistic as the sine band — fast attack so speech onset lands
    // immediately, slower release so crests decay instead of snapping flat.
    const smoother = createAmplitudeSmoother({ attackMs: 80, releaseMs: 350 });
    const histories = layers.map((layer) =>
      createAmplitudeHistory({ size: HISTORY, periodMs: layer.periodMs }),
    );
    const scratch = new Float32Array(HISTORY);
    let raf = 0;
    let lastTime = performance.now();
    let lastAmpWritten = "";

    const tick = (now: number) => {
      // Clamp the delta so a backgrounded tab resumes smoothly rather than
      // flushing minutes of history in one frame.
      const dt = Math.min(100, now - lastTime);
      lastTime = now;
      const target = Math.min(1, Math.max(0, getAmplitudeRef.current()));
      const amp = smoother.step(target, dt);

      // Keep publishing `--voice-amp`: the existing placement CSS reads it for
      // the band's rise/recede and brightness, which still composes on top of
      // the reactive geometry.
      const ampText = amp.toFixed(3);
      if (ampText !== lastAmpWritten) {
        lastAmpWritten = ampText;
        node.style.setProperty("--voice-amp", ampText);
      }

      const timeSec = now / 1000;
      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        // Every layer is fed the same amplitude; the differing cadences are
        // what turn one signal into a layered, parallaxed terrain.
        histories[i].push(amp, dt);
        histories[i].read(scratch, layer.smooth);
        toViewBoxY(layer, timeSec, scratch);
        // Paths are ordered back→front per half, so a mirrored (center /
        // inline) band walks the same layer list twice.
        const d = buildPath(scratch, waveStyle);
        for (let h = i; h < paths.length; h += layers.length) {
          paths[h].setAttribute("d", d);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // `placement` belongs here even though the loop never reads it: mirrored
    // placements render each layer twice, so switching between a single band
    // and a mirrored one changes the path count under a loop that captured the
    // node list once. Without this, a live `wavePlacement` change (the
    // Storybook knob does exactly that) leaves half the paths frozen.
  }, [layers, waveStyle, placement]);

  const className = [
    "voice-listening-waves",
    "voice-listening-waves--reactive",
    `voice-listening-waves--${waveStyle}`,
    `voice-listening-waves--${palette}`,
    `voice-listening-waves--${placement}`,
  ].join(" ");

  // `d` is intentionally empty at mount: the first rAF frame fills it. An
  // authored placeholder would flash a shape that is not the signal.
  const svgLayers = (half: string) =>
    layers.map((layer) => (
      <svg
        key={`${half}-${layer.modifier}`}
        className={`voice-wave voice-wave--${layer.modifier}`}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
      >
        <path data-reactive-wave="" d="" />
      </svg>
    ));

  // Center/inline mirror the band into two halves meeting at the midline, so
  // the fill hugs the centre line from above and below (see the sine band).
  if (placement === "center" || placement === "inline") {
    return (
      <div ref={ref} className={className} aria-hidden>
        <div className="voice-listening-waves__half voice-listening-waves__half--top">
          {svgLayers("top")}
        </div>
        <div className="voice-listening-waves__half voice-listening-waves__half--bottom">
          {svgLayers("bottom")}
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} className={className} aria-hidden>
      {svgLayers("single")}
    </div>
  );
}
