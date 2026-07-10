/**
 * Listening-state waves for the voice room: layered sine waves that rise from
 * the bottom edge of the screen as the user speaks — the visual language of
 * energy coming *in* (the user's voice arriving), the counterpart to the
 * assistant's outward `responding` pulse on the avatar.
 *
 * The waves always drift horizontally (a slow CSS loop); the user's live mic
 * amplitude drives how high they rise and how bright they are, written
 * imperatively to `--voice-amp` from a requestAnimationFrame loop — never React
 * state, matching `voice-avatar.tsx`. Purely decorative; the cyan→indigo accent
 * is a fixed constant (like the listening sonar), not a theme token.
 */

import { useEffect, useRef } from "react";

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
 * (`--avatar-accent`).
 */
export type VoiceWavePalette = "aurora" | "accent";

export function VoiceListeningWaves({
  getAmplitude,
  waveStyle = "fill",
  palette = "aurora",
}: {
  /** Mic amplitude source (0–1), polled in a rAF loop. */
  getAmplitude: () => number;
  waveStyle?: VoiceWaveStyle;
  palette?: VoiceWavePalette;
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
    let raf = 0;
    let lastWritten = "";
    const tick = () => {
      const amp = Math.min(1, Math.max(0, getAmplitudeRef.current()));
      const next = amp.toFixed(3);
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

  return (
    <div
      ref={ref}
      className={`voice-listening-waves voice-listening-waves--${waveStyle} voice-listening-waves--${palette}`}
      aria-hidden
    >
      {WAVE_LAYERS.map((layer) => (
        <svg
          key={layer.modifier}
          className={`voice-wave voice-wave--${layer.modifier}`}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
        >
          <path d={buildPath(layer.amplitude, layer.cycles, layer.phase)} />
        </svg>
      ))}
    </div>
  );
}
