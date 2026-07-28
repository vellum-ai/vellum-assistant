/**
 * Text projection for `ui_surface` content blocks.
 *
 * Surfaces are rendering instructions, so every provider drops them when
 * serializing history. The supported way to give the model the surface's
 * meaning is the sibling `_surfaceFallback` text block that producers emit
 * alongside the card (see `notifications/approval-card-builder.ts`).
 *
 * This projection is the recovery path for messages that carry a surface and
 * nothing else — historical rows written before their producer emitted a
 * fallback (voice `call_summary` rows are the known case). Without it those
 * turns reach the provider as a bare "blocks omitted" sentinel and the model
 * cannot tell that the call happened at all.
 *
 * Deliberately narrow: it reads only fields that already hold display copy and
 * returns null when there is nothing meaningful to say, so a message that
 * already has real text is never padded with card chrome.
 */

import type { UiSurfaceContent } from "./types.js";

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Render a surface block as a single plain-text line, or null when the block
 * carries no display copy worth sending.
 */
export function uiSurfaceFallbackText(block: UiSurfaceContent): string | null {
  const data = block.data ?? {};

  // `summaryText` is the canonical already-written summary line (call
  // summaries, work results) — prefer it verbatim over reassembling one.
  const summary = trimmedString(data.summaryText);
  if (summary) {
    return summary;
  }

  const title = trimmedString(block.title) ?? trimmedString(data.title);
  const subtitle = trimmedString(data.subtitle) ?? trimmedString(data.body);
  if (title && subtitle) {
    return `${title} — ${subtitle}`;
  }
  return title ?? subtitle;
}
