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
 * Round `rawStep` up to the nearest "nice" value (1, 2, 2.5, or 5 × 10^n).
 * This is the standard algorithm used by D3, Chart.js, and similar charting
 * libraries to produce clean, human-readable axis labels.
 *
 * @see https://observablehq.com/@d3/d3-ticks — D3's tick generation reference
 */
export function niceStep(rawStep: number): number {
  if (rawStep <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  let nice: number;
  if (normalized <= 1) nice = 1;
  else if (normalized <= 2) nice = 2;
  else if (normalized <= 2.5) nice = 2.5;
  else if (normalized <= 5) nice = 5;
  else nice = 10;
  return nice * magnitude;
}

/**
 * Return the number of decimal digits needed to display a nice step exactly.
 * Since nice steps are always `n × 10^k` where `n ∈ {1, 2, 2.5, 5}`, this
 * is deterministic — no heuristics, no floating-point guessing.
 */
export function niceStepDigits(step: number): number {
  if (step >= 1) return Number.isInteger(step) ? 0 : 1;
  const magnitude = 10 ** Math.floor(Math.log10(step));
  const normalized = step / magnitude;
  const is25 = Math.abs(normalized - 2.5) < 0.01;
  return Math.ceil(-Math.log10(step)) + (is25 ? 1 : 0);
}

/**
 * Compute a "nice" Y-axis ceiling so that `result / tickCount` is a clean
 * round number and every axis label matches its gridline position exactly.
 *
 * For integer-only metrics (e.g. event counts) pass `integerOnly: true` to
 * guarantee whole-number ticks divisible by `tickCount`.
 */
export function niceMax(
  values: number[],
  opts?: { integerOnly?: boolean; tickCount?: number },
): number {
  const raw = Math.max(0, ...values);
  const tickCount = opts?.tickCount ?? 5;

  if (raw === 0) return opts?.integerOnly ? tickCount : 1;

  if (opts?.integerOnly) {
    const step = Math.max(1, Math.ceil(raw / tickCount));
    return step * tickCount;
  }

  const step = niceStep(raw / tickCount);
  return step * tickCount;
}

/** Generate `count + 1` evenly-spaced tick values from 0 to `max`. */
export function generateTicks(max: number, count: number): number[] {
  if (max === 0) return [0];
  const step = max / count;
  // Round each tick to the step's precision to avoid floating-point drift
  // (e.g. 0.2 × 3 = 0.6000000000000001).
  const precision = step >= 1 ? 0 : Math.ceil(-Math.log10(step)) + 2;
  const factor = 10 ** precision;
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) {
    ticks.push(Math.round(step * i * factor) / factor);
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
