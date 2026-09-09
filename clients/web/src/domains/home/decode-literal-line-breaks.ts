/**
 * Models sometimes write the two-character sequence `\n` (or `\t`) instead of
 * a real line break. Markdown then treats the briefing as one line, which is
 * what makes a scheduled-run card unreadable in the notifications bell.
 *
 * Real newlines and tabs are left alone. A backslash that is not part of `\n`
 * or `\t` is left alone too.
 */
export function decodeLiteralLineBreaks(text: string): string {
  if (!text.includes("\\")) {
    return text;
  }
  return text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}
