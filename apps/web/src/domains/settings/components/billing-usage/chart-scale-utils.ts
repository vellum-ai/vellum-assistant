/**
 * Pure math/scale utilities for the billing usage SVG chart.
 * Framework-agnostic — no React dependency.
 */

/** Create a linear scale mapping a numeric domain to a pixel range. */
export function linearScale(
  domain: [number, number],
  range: [number, number],
): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/**
 * Round a raw max up to the nearest "nice" ceiling so axis labels are
 * round numbers. For integer-only metrics pass `integerOnly: true` to
 * guarantee the result is a whole number divisible by `tickCount`.
 */
export function niceMax(
  values: number[],
  opts?: { integerOnly?: boolean; tickCount?: number },
): number {
  const raw = Math.max(0, ...values);
  if (raw === 0) return opts?.integerOnly ? (opts.tickCount ?? 5) : 1;

  if (opts?.integerOnly) {
    const tickCount = opts.tickCount ?? 5;
    return Math.ceil(raw / tickCount) * tickCount;
  }

  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return Math.ceil(raw / magnitude) * magnitude;
}

/** Generate `count + 1` evenly-spaced tick values from 0 to `max`. */
export function generateTicks(max: number, count: number): number[] {
  if (max === 0) return [0];
  const step = max / count;
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) {
    ticks.push(step * i);
  }
  return ticks;
}

/** SVG path for a rect with only the top-left and top-right corners rounded. */
export function topRoundedRect(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): string {
  const clampedR = Math.min(r, w / 2, h / 2);
  return [
    `M${x},${y + clampedR}`,
    `A${clampedR},${clampedR} 0 0 1 ${x + clampedR},${y}`,
    `H${x + w - clampedR}`,
    `A${clampedR},${clampedR} 0 0 1 ${x + w},${y + clampedR}`,
    `V${y + h}`,
    `H${x}`,
    `Z`,
  ].join("");
}

/** Pick evenly-spaced X label indices that avoid overlap on narrow viewports. */
export function pickXTickIndices(
  total: number,
  isMobile: boolean,
): number[] {
  if (total <= 0) return [];
  if (isMobile) {
    if (total <= 3) return Array.from({ length: total }, (_, i) => i);
    return [0, Math.floor(total / 2), total - 1];
  }
  const maxTicks = Math.min(total, 12);
  const step = Math.max(1, Math.ceil(total / maxTicks));
  const indices: number[] = [];
  for (let i = 0; i < total; i += step) indices.push(i);
  if (indices[indices.length - 1] !== total - 1) indices.push(total - 1);
  return indices;
}
