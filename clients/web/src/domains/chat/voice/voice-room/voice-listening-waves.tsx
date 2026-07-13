/**
 * Listening-state waves for the voice room: layered sine waves that swell as
 * the user speaks — the visual language of energy coming *in* (the user's
 * voice arriving), the counterpart to the assistant's outward `responding`
 * pulse on the avatar. `placement` anchors the band: `bottom` rises from the
 * floor edge (the void look), `center` is a symmetric band around the middle
 * (the color look, gathering behind the centered eyes).
 *
 * The waves always drift horizontally (a slow CSS loop); the user's live mic
 * amplitude drives how high they rise and how bright they are, written
 * imperatively to `--voice-amp` from a requestAnimationFrame loop — never React
 * state, matching `voice-avatar.tsx`. The polled amplitude is near-instant RMS
 * (see `createAmplitudeSmoother`), so the loop runs it through a VU-meter-style
 * attack/release smoother before writing — raw, it jerks the waves' large
 * vertical travel every frame. Purely decorative; the cyan→indigo accent is a
 * fixed constant (like the listening sonar), not a theme token.
 */

import { useEffect, useRef } from "react";

import { createAmplitudeSmoother } from "./voice-motion";

// Wave geometry is authored in a fixed viewBox; the path spans two viewBox
// widths so a `-1200px` horizontal drift loops seamlessly (each wave's cycle
// count over the doubled width is even, so the halves tile).
const VIEW_W = 1200;
const VIEW_H = 200;

/** Sample points along a sine wave spanning two viewBox widths. */
function wavePoints(amplitude: number, cyclesOverDoubleWidth: number, phase: number): string {
  const width = VIEW_W * 2;
  const steps = 120;
  const baseline = VIEW_H - amplitude - 4;
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * width;
    const y =
      baseline -
      amplitude * Math.sin((i / steps) * cyclesOverDoubleWidth * 2 * Math.PI + phase);
    d += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)} `;
  }
  return d;
}

/** Filled variant: the sine curve closed down to the bottom edge (a water fill). */
function wavePathFill(amplitude: number, cycles: number, phase: number): string {
  return `${wavePoints(amplitude, cycles, phase)}L${VIEW_W * 2},${VIEW_H} L0,${VIEW_H} Z`;
}

/** Line variant: just the open sine curve, stroked (a luminous ribbon). */
function wavePathLine(amplitude: number, cycles: number, phase: number): string {
  return wavePoints(amplitude, cycles, phase).trimEnd();
}

// Back → front: taller/slower behind, tighter/faster in front, each an even
// cycle count so the doubled path tiles under the drift.
const WAVE_LAYERS = [
  { modifier: "back" as const, amplitude: 26, cycles: 4, phase: 0 },
  { modifier: "mid" as const, amplitude: 34, cycles: 6, phase: 1.1 },
  { modifier: "front" as const, amplitude: 22, cycles: 8, phase: 2.3 },
];

/** Style of the listening waves: filled "water" areas or stroked "ribbon" lines. */
export type VoiceWaveStyle = "fill" | "line";

/**
 * Color language: `aurora` is the fixed cyan→indigo accent (matches the
 * listening sonar); `accent` tints the waves from the assistant's avatar color
 * (`--avatar-accent`); `tone` follows the room foreground (`--room-fg`) so the
 * waves read on any solid avatar-color background (the color look).
 */
export type VoiceWavePalette = "aurora" | "accent" | "tone";

/**
 * Where the wave band sits: `bottom` rises from the floor edge (the void
 * look), `top` sweeps in from the ceiling edge (the color look — the voice
 * arriving above the centered eyes, leaving them clear), `center` swells
 * symmetrically around the middle of the screen.
 */
export type VoiceWavePlacement = "bottom" | "top" | "center";

export function VoiceListeningWaves({
  getAmplitude,
  waveStyle = "fill",
  palette = "aurora",
  placement = "bottom",
}: {
  /** Mic amplitude source (0–1), polled in a rAF loop. */
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

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    // Rise quickly with speech onset (~80 ms) but settle gently (~350 ms), so
    // the band swells and subsides instead of twitching with raw RMS.
    const smoother = createAmplitudeSmoother({ attackMs: 80, releaseMs: 350 });
    let raf = 0;
    let lastWritten = "";
    let lastTime = performance.now();
    const tick = (now: number) => {
      const dt = now - lastTime;
      lastTime = now;
      const target = Math.min(1, Math.max(0, getAmplitudeRef.current()));
      const next = smoother.step(target, dt).toFixed(3);
      if (next !== lastWritten) {
        lastWritten = next;
        node.style.setProperty("--voice-amp", next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const buildPath = waveStyle === "line" ? wavePathLine : wavePathFill;

  const layers = () =>
    WAVE_LAYERS.map((layer) => (
      <svg
        key={layer.modifier}
        className={`voice-wave voice-wave--${layer.modifier}`}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
      >
        <path d={buildPath(layer.amplitude, layer.cycles, layer.phase)} />
      </svg>
    ));

  const className = `voice-listening-waves voice-listening-waves--${waveStyle} voice-listening-waves--${palette} voice-listening-waves--${placement}`;

  // Center: the wave fill hugs the bottom edge of its box, so a merely
  // centered box would still read low. Mirror the band into two halves that
  // meet at the midline — the fill hugs the center line from above and below,
  // its wavy edges rippling outward — for a waveform that is visually centered.
  if (placement === "center") {
    return (
      <div ref={ref} className={className} aria-hidden>
        <div className="voice-listening-waves__half voice-listening-waves__half--top">
          {layers()}
        </div>
        <div className="voice-listening-waves__half voice-listening-waves__half--bottom">
          {layers()}
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} className={className} aria-hidden>
      {layers()}
    </div>
  );
}
