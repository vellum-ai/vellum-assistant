/**
 * Pure helpers for wrapping textarea selections with markdown syntax markers.
 * Exported for unit tests — the ChatComposer `onKeyDown` handler delegates to
 * {@link applyMarkdownFormatting} to keep behavior testable without a DOM harness.
 */

interface FormattingResult {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * Wrap or unwrap the current textarea selection with a markdown syntax marker.
 *
 * Behavior:
 * - **Selected text already wrapped**: removes the markers (toggle off).
 * - **Selected text not wrapped**: wraps with markers (toggle on).
 * - **No selection (collapsed cursor)**: inserts paired markers with cursor between them.
 */
export function applyMarkdownFormatting(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  marker: string,
): FormattingResult {
  const len = marker.length;
  const selected = text.slice(selectionStart, selectionEnd);

  if (selectionStart === selectionEnd) {
    // No selection — insert paired markers with cursor between them
    const before = text.slice(0, selectionStart);
    const after = text.slice(selectionEnd);
    return {
      text: before + marker + marker + after,
      selectionStart: selectionStart + len,
      selectionEnd: selectionStart + len,
    };
  }

  // Check if selection is already wrapped with the marker
  const beforeStart = selectionStart - len;
  const afterEnd = selectionEnd + len;
  if (
    beforeStart >= 0 &&
    afterEnd <= text.length &&
    text.slice(beforeStart, selectionStart) === marker &&
    text.slice(selectionEnd, afterEnd) === marker
  ) {
    // Toggle off — remove markers
    const before = text.slice(0, beforeStart);
    const after = text.slice(afterEnd);
    return {
      text: before + selected + after,
      selectionStart: beforeStart,
      selectionEnd: beforeStart + selected.length,
    };
  }

  // Wrap selection with markers
  const before = text.slice(0, selectionStart);
  const after = text.slice(selectionEnd);
  return {
    text: before + marker + selected + marker + after,
    selectionStart: selectionStart + len,
    selectionEnd: selectionEnd + len,
  };
}

interface FormattingShortcut {
  marker: string;
  key: string;
  shiftKey: boolean;
}

/**
 * Map of formatting keyboard shortcuts following Slack/Discord/GitHub conventions:
 * - Ctrl/Cmd+B → Bold (`**`)
 * - Ctrl/Cmd+I → Italic (`*`)
 * - Ctrl/Cmd+Shift+X → Strikethrough (`~~`)
 * - Ctrl/Cmd+Shift+C → Inline code (`` ` ``)
 */
export const FORMATTING_SHORTCUTS: FormattingShortcut[] = [
  { marker: "**", key: "b", shiftKey: false },
  { marker: "*", key: "i", shiftKey: false },
  { marker: "~~", key: "x", shiftKey: true },
  { marker: "`", key: "c", shiftKey: true },
];

/**
 * Check if a keyboard event matches a formatting shortcut and return the marker.
 * Returns `null` if the event does not match any formatting shortcut.
 */
export function matchFormattingShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): string | null {
  const hasModifier = event.metaKey || event.ctrlKey;
  if (!hasModifier) return null;

  const keyLower = event.key.toLowerCase();
  for (const shortcut of FORMATTING_SHORTCUTS) {
    if (keyLower === shortcut.key && event.shiftKey === shortcut.shiftKey) {
      return shortcut.marker;
    }
  }
  return null;
}
