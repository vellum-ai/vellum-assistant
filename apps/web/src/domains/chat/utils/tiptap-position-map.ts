/**
 * Position mapping between plain-text character offsets (used by stored comment
 * anchors) and ProseMirror document positions.
 *
 * Comment anchors persist start/end as character offsets into the document's
 * plain text. ProseMirror uses its own position scheme that accounts for node
 * boundaries, so we need conversion helpers when applying or reading anchors.
 */

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommentAnchor {
  commentId: string;
  anchorStart: number;
  anchorEnd: number;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert a plain-text character offset to a ProseMirror document position.
 *
 * Walks every text node in document order, tracking a cumulative character
 * count. Returns the PM position corresponding to `charOffset` characters
 * into the document's concatenated text content.
 *
 * Edge cases:
 * - Offset beyond document end: clamped to the last valid text position.
 * - Offset 0: returns the position of the first character in the document.
 */
export function charOffsetToPmPos(
  doc: ProseMirrorNode,
  charOffset: number,
): number {
  let cumulative = 0;
  let result = -1;

  doc.descendants((node, pos) => {
    // Already found — skip remaining nodes
    if (result >= 0) return false;

    if (node.isText) {
      const text = node.text ?? "";
      const nodeEnd = cumulative + text.length;

      if (charOffset <= nodeEnd) {
        // The target offset lands within (or at the boundary of) this node
        result = pos + (charOffset - cumulative);
        return false;
      }

      cumulative = nodeEnd;
    }

    return true; // continue traversal
  });

  // If we exhausted the document without finding the offset, clamp to doc end
  if (result < 0) {
    result = doc.content.size;
  }

  return result;
}

/**
 * Convert a ProseMirror document position to a plain-text character offset.
 *
 * Inverse of `charOffsetToPmPos`. Walks text nodes and accumulates character
 * counts until the cumulative PM position passes `pmPos`.
 *
 * Edge cases:
 * - Position inside a non-text node: snaps to the nearest text boundary
 *   (the end of the previous text node or the start of the next one).
 * - Position beyond document end: returns total text length.
 */
export function pmPosToCharOffset(
  doc: ProseMirrorNode,
  pmPos: number,
): number {
  let charOffset = 0;

  doc.descendants((node, pos) => {
    if (node.isText) {
      const text = node.text ?? "";
      const nodeEndPos = pos + text.length;

      if (pmPos <= nodeEndPos) {
        // Target is within or before this text node
        const offsetInNode = Math.max(0, pmPos - pos);
        charOffset += offsetInNode;
        return false; // stop traversal
      }

      charOffset += text.length;
    }

    return true;
  });

  return charOffset;
}
