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
  //    Handles multiple balanced parentheses groups in URLs (e.g. Wikipedia
  //    links, URL-encoded paths with multiple `(...)` segments).
  result = result.replace(
    /\[([^\]]+)\]\((?:[^()]*\([^()]*\))*[^()]*\)/g,
    "$1",
  );

  // 2. Bold+italic: ***text*** or ___text___ → text
  result = result.replace(/\*{3}(.+?)\*{3}/g, "$1");
  result = result.replace(/_{3}(.+?)_{3}/g, "$1");

  // 3. Bold: **text** or __text__ → text
  result = result.replace(/\*{2}(.+?)\*{2}/g, "$1");
  result = result.replace(/_{2}(.+?)_{2}/g, "$1");

  // 4. Code fences + headers: strip ```...``` fences keeping content, and
  //    strip leading `#` header characters at line starts — but ONLY outside
  //    code fences so `# comment` / `## comment` lines inside code blocks are
  //    preserved verbatim.
  {
    const fenceRe = /(```[^\n]*\n[\s\S]*?```\n?)/g;
    const parts = result.split(fenceRe);
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        // Non-fence segment: strip headers.
        parts[i] = parts[i].replace(/^#{1,6}\s+/gm, "");
      } else {
        // Fence segment: strip the ``` markers but keep content untouched.
        parts[i] = parts[i].replace(
          /```[^\n]*\n([\s\S]*?)```\n?/,
          "$1",
        );
      }
    }
    result = parts.join("");
  }

  // 5. Inline code: strip single backticks
  result = result.replace(/`([^`]+)`/g, "$1");

  // 6. Bullet markers: strip `- ` or `* ` at line starts
  //    Must run before italic stripping so `* item` is treated as a bullet.
  result = result.replace(/^[-*]\s+/gm, "");

  // 7. Italic: *text* or _text_ → text
  //    Word-boundary-aware to preserve arithmetic like `5 * 3` and identifiers like `my_var`.
  result = result.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, "$1");
  result = result.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1");

  // 8. Emojis: strip extended pictographic characters, variation selectors,
  //    zero-width joiners, skin tone modifiers, and regional indicator symbols (flags).
  result = result.replace(/[\u200D\uFE00-\uFE0F]/gu, "");
  result = result.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");
  result = result.replace(/\p{Extended_Pictographic}/gu, "");
  result = result.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "");

  // 9. Collapse whitespace: multiple spaces → single space,
  //    multiple blank lines → single newline.
  //    Does NOT trim trailing whitespace — callers handle trimming so that
  //    streaming chunks preserve inter-word spaces (e.g. "Hello " + "world").
  result = result.replace(/ {2,}/g, " ");
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}
