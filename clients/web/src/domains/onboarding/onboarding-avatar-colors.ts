/**
 * Which avatar colors read well overlaid on top of a given avatar color.
 *
 * SPIKE — research-onboarding flow.
 *
 * Used when a character is drawn over a background tinted with another avatar
 * color (e.g. the tone characters peeking over the assistant's color on the
 * "How should I talk?" step). Each entry lists good companions, ordered best
 * contrast first, and follows the rules:
 *   - never the same color over itself,
 *   - warm clashes are out — orange / pink / red are never paired together,
 *   - avoid same-family, low-contrast pairs (e.g. teal over green).
 *
 * Palette ids: green, orange, pink, purple, teal, yellow.
 */
export const AVATAR_OVERLAY_COLORS: Record<string, string[]> = {
  green: ["pink", "purple", "orange", "yellow"],
  orange: ["teal", "purple", "green", "yellow"],
  pink: ["teal", "green", "yellow", "purple"],
  purple: ["yellow", "teal", "green", "orange"],
  teal: ["pink", "orange", "yellow", "purple"],
  yellow: ["purple", "teal", "pink", "green"],
};

/**
 * Colors that work well over `baseColorId`, falling back to "anything but the
 * base" if the base isn't in the map.
 */
export function overlayColorsFor(
  baseColorId: string,
  allColorIds: readonly string[],
): string[] {
  const preferred = AVATAR_OVERLAY_COLORS[baseColorId];
  if (preferred && preferred.length > 0) return preferred;
  return allColorIds.filter((id) => id !== baseColorId);
}

/** Warm colors that shouldn't be paired with each other (orange/pink/red). */
const WARM_CLASH = new Set(["orange", "pink", "red"]);
function clash(a: string, b: string): boolean {
  return WARM_CLASH.has(a) && WARM_CLASH.has(b);
}

/**
 * Pick `count` colors that read well over `baseColorId` AND don't clash with
 * each other (so several can be overlapped together). Best-contrast first;
 * falls back to filling from the remaining candidates if the clash rule leaves
 * too few.
 */
export function pickOverlayColors(
  baseColorId: string,
  allColorIds: readonly string[],
  count: number,
): string[] {
  const candidates = overlayColorsFor(baseColorId, allColorIds);
  const picked: string[] = [];
  for (const c of candidates) {
    if (picked.length >= count) break;
    if (picked.some((p) => clash(p, c))) continue;
    picked.push(c);
  }
  for (const c of candidates) {
    if (picked.length >= count) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked;
}
