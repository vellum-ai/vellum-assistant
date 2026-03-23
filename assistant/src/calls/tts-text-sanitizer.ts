/**
 * Sanitizes text for TTS synthesis by stripping markdown formatting and emojis.
 *
 * Preserves arithmetic expressions (e.g. `5 * 3`), identifiers with underscores
 * (e.g. `my_var`), and Fish Audio S2 bracket annotations (e.g. `[laughter]`).
 */
export function sanitizeForTts(text: string): string {
  let result = text;

  // 1. Markdown links: [text](url) → text
  //    Only matches the full [...](...) pattern — plain brackets like
  //    Fish Audio S2 annotations ([laughter], [breath]) pass through.
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // 2. Bold+italic: ***text*** or ___text___ → text
  result = result.replace(/\*{3}(.+?)\*{3}/g, "$1");
  result = result.replace(/_{3}(.+?)_{3}/g, "$1");

  // 3. Bold: **text** or __text__ → text
  result = result.replace(/\*{2}(.+?)\*{2}/g, "$1");
  result = result.replace(/_{2}(.+?)_{2}/g, "$1");

  // 4. Headers: strip leading # characters at line starts
  result = result.replace(/^#{1,6}\s+/gm, "");

  // 5. Code fences: strip ```...``` fences but keep content
  result = result.replace(/```[^\n]*\n([\s\S]*?)```\n?/g, "$1");

  // 6. Inline code: strip single backticks
  result = result.replace(/`([^`]+)`/g, "$1");

  // 7. Bullet markers: strip `- ` or `* ` at line starts
  //    Must run before italic stripping so `* item` is treated as a bullet.
  result = result.replace(/^[-*]\s+/gm, "");

  // 8. Italic: *text* or _text_ → text
  //    Word-boundary-aware to preserve arithmetic like `5 * 3` and identifiers like `my_var`.
  result = result.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, "$1");
  result = result.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1");

  // 9. Emojis: strip extended pictographic characters, variation selectors,
  //    zero-width joiners, skin tone modifiers, and regional indicator symbols (flags).
  result = result.replace(/[\u200D\uFE00-\uFE0F]/gu, "");
  result = result.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");
  result = result.replace(/\p{Extended_Pictographic}/gu, "");
  result = result.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "");

  // 10. Collapse whitespace: multiple spaces → single space,
  //     multiple blank lines → single newline
  result = result.replace(/ {2,}/g, " ");
  result = result.replace(/\n{3,}/g, "\n\n");
  // Trim trailing whitespace from each line
  result = result.replace(/[ \t]+$/gm, "");
  // Collapse resulting consecutive blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}
