/**
 * How many bytes of a workspace file the browser will pull down to show it.
 *
 * Shared by the transcript's inline embeds and the drawer's read-only preview
 * so one file is refused at the same size wherever it is opened, and so the two
 * ceilings stay next to the reason they differ.
 */

import type { WorkspaceFilePreviewKind } from "@/stores/viewer-store";

/**
 * Media plays from an object URL, so the cost is the file itself held once in
 * memory. Generous enough for a screen recording, short of streaming a whole
 * archive of footage into the tab.
 */
export const MAX_INLINE_MEDIA_BYTES = 100 * 1024 * 1024;

/**
 * A parsed preview holds the file plus its parsed form, so the same budget
 * buys far less. Past this the reader is better served by downloading the file
 * and opening it in the app that owns the format.
 */
export const MAX_PARSED_PREVIEW_BYTES = 25 * 1024 * 1024;

/** The ceiling that applies to a drawer preview of `previewKind`. */
export function previewByteCapFor(
  previewKind: WorkspaceFilePreviewKind,
): number {
  switch (previewKind) {
    case "image":
    case "audio":
    case "video":
      return MAX_INLINE_MEDIA_BYTES;
    default:
      return MAX_PARSED_PREVIEW_BYTES;
  }
}
