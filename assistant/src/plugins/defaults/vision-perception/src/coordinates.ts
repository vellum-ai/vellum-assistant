/**
 * Bounding-box contract for the grounding vision tools (`vlm_ocr`, `vlm_detect`).
 *
 * The Qwen vision family emits grounding coordinates on a 0–1000 scale relative
 * to the image; we normalize everything we surface to that same contract so the
 * model never has to reason about raw pixel dimensions. Each detection echoes
 * `image_size: [width, height]` (the real pixel size, parsed from the resolved
 * image bytes via `parseImageDimensions`) so a caller can map the normalized box
 * back to pixels when it needs to.
 *
 * The model is asked to return JSON; in practice it sometimes wraps that JSON in
 * a ```json fenced block or prefixes/suffixes prose, so {@link parseModelJson}
 * is deliberately tolerant of both shapes.
 */

import { parseImageDimensions } from "../../../../context/image-dimensions.js";
import { parseJsonSafe } from "../../../../util/json.js";
import { resolveVisionMedia } from "./media-source.js";

/** The fixed scale the grounding tools normalize boxes onto. */
export const COORD_SCALE = 1000;

/** A normalized bounding box: `[x0, y0, x1, y1]` on a 0–{@link COORD_SCALE} scale. */
export type BBox = [number, number, number, number];

/** Image pixel dimensions echoed alongside every grounding result. */
export type ImageSize = [number, number];

/**
 * Resolve a media reference's real pixel dimensions, reading the same attachment
 * bytes the vision call uses. Returns `[0, 0]` when the dimensions can't be
 * parsed (an unrecognized or truncated format) — callers still get a usable
 * result, just without a pixel-mapping anchor. Throws only what
 * `resolveVisionMedia` throws (a missing / non-image reference), which the tools
 * convert into `{ isError: true }`.
 */
export async function resolveImageSize(mediaRef: string): Promise<ImageSize> {
  const media = await resolveVisionMedia(mediaRef);
  const dims = parseImageDimensions(media.block.source.data, media.mimeType);
  return dims ? [dims.width, dims.height] : [0, 0];
}

/**
 * Clamp a single coordinate onto the `[0, COORD_SCALE]` range, rounding to an
 * integer. Non-finite inputs (NaN, Infinity) collapse to 0.
 */
function clampCoord(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(COORD_SCALE, Math.max(0, Math.round(value)));
}

/**
 * Normalize a raw 4-tuple box onto the 0–{@link COORD_SCALE} contract.
 *
 * A box whose every coordinate is already within `[0, 1]` is treated as a
 * fractional box and scaled up; otherwise it is assumed to already be on (or
 * near) the 0–1000 scale and is only clamped. Coordinates are reordered so
 * `x0 <= x1` and `y0 <= y1`. Returns `null` when `raw` isn't four finite
 * numbers.
 */
export function normalizeBox(raw: unknown): BBox | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const nums = raw.map((n) => (typeof n === "number" ? n : Number(n)));
  if (nums.some((n) => !Number.isFinite(n))) return null;

  const fractional = nums.every((n) => n >= 0 && n <= 1);
  const scaled = fractional ? nums.map((n) => n * COORD_SCALE) : nums;

  const [a, b, c, d] = scaled.map(clampCoord);
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

/**
 * Normalize a list of raw boxes, dropping any that aren't valid 4-tuples.
 * `imageSize` is accepted for interface symmetry with callers that thread the
 * echoed size through; normalization itself is size-independent because the
 * contract is a fixed 0–1000 scale.
 */
export function normalizeBoxes(raw: unknown, _imageSize: ImageSize): BBox[] {
  if (!Array.isArray(raw)) return [];
  const out: BBox[] = [];
  for (const candidate of raw) {
    const box = normalizeBox(candidate);
    if (box) out.push(box);
  }
  return out;
}

/**
 * Parse JSON out of a model response that may be a bare JSON value, JSON wrapped
 * in a ```json (or plain ```) fenced block, or JSON embedded in surrounding
 * prose. Returns `null` when nothing parses — callers degrade to
 * `{ isError: true }` rather than throwing.
 */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. Bare JSON.
  const direct = parseJsonSafe(trimmed);
  if (direct !== null) return direct;

  // 2. Fenced block: ```json ... ``` or ``` ... ```.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    const parsed = parseJsonSafe(fenced[1].trim());
    if (parsed !== null) return parsed;
  }

  // 3. First {...} or [...] span embedded in prose.
  const span = extractJsonSpan(trimmed);
  if (span) {
    const parsed = parseJsonSafe(span);
    if (parsed !== null) return parsed;
  }

  return null;
}

/**
 * Extract the first balanced `{...}` or `[...]` span from `text`, ignoring
 * braces/brackets that appear inside string literals. Returns `null` when no
 * candidate opener is found.
 */
function extractJsonSpan(text: string): string | null {
  const objStart = text.indexOf("{");
  const arrStart = text.indexOf("[");
  const start =
    objStart === -1
      ? arrStart
      : arrStart === -1
        ? objStart
        : Math.min(objStart, arrStart);
  if (start === -1) return null;

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}
