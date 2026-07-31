/**
 * Single-line preview label for a thinking segment shown in pill / header
 * chrome, which renders plain text, not markdown.
 *
 * Reasoning summaries usually open with a bold markdown headline
 * (`**Considering formatting options** I'm pondering …`). Rendered as plain
 * text the asterisks show literally and the body crowds the headline, so the
 * preview extracts JUST the headline. Text without a leading bold headline
 * (e.g. a web-synthesized "Reading …" step) passes through unchanged. The
 * full markdown lives behind the drill-in detail views, which render it via
 * `ChatMarkdownMessage`.
 */
export function thinkingPreview(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("**")) {
    return text;
  }
  const close = trimmed.indexOf("**", 2);
  if (close === -1) {
    // The headline is still streaming (no closing marker yet), so show the
    // partial headline without the literal asterisks. It settles to the
    // extracted headline once the closing marker lands.
    return trimmed.slice(2).trimStart();
  }
  const headline = trimmed.slice(2, close).trim();
  return headline.length > 0 ? headline : text;
}
