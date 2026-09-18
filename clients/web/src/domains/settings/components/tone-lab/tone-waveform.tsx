import { useEffect, useRef } from "react";

import { renderTone, type ToneRecipe } from "@/lib/sounds/tone-synth";

const HEIGHT = 72;

/**
 * The recipe's rendered waveform, drawn as a min/max envelope per pixel column.
 * Re-renders offline whenever the recipe changes; a render that is overtaken
 * by a newer recipe is dropped.
 */
export function ToneWaveform({
  recipe,
  label,
}: {
  recipe: ToneRecipe;
  label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    void renderTone(recipe).then((samples) => {
      const canvas = canvasRef.current;
      if (cancelled || !samples || !canvas) {
        return;
      }
      drawWaveform(canvas, samples);
    });
    return () => {
      cancelled = true;
    };
  }, [recipe]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={label}
      className="h-[72px] w-full rounded-lg bg-[var(--surface-base)] text-[var(--content-secondary)]"
      height={HEIGHT}
    />
  );
}

function drawWaveform(canvas: HTMLCanvasElement, samples: Float32Array): void {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.round(HEIGHT * dpr);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  let peak = 0;
  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample));
  }
  const scale = peak > 0 ? (height / 2 - 2 * dpr) / peak : 0;
  const mid = height / 2;
  const perColumn = samples.length / width;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = getComputedStyle(canvas).color;
  for (let x = 0; x < width; x += 1) {
    const from = Math.floor(x * perColumn);
    const to = Math.max(from + 1, Math.floor((x + 1) * perColumn));
    let min = 0;
    let max = 0;
    for (let i = from; i < to && i < samples.length; i += 1) {
      const sample = samples[i] ?? 0;
      min = Math.min(min, sample);
      max = Math.max(max, sample);
    }
    const top = mid - max * scale;
    const bottom = mid - min * scale;
    ctx.fillRect(x, top, 1, Math.max(dpr, bottom - top));
  }
}
