/**
 * Lightweight Block Kit block generation for Slack channel replies.
 *
 * The gateway's text-to-blocks utility handles the full conversion, but
 * the assistant pre-generates blocks so the gateway can pass them through
 * without re-parsing. This keeps the conversion logic self-contained and
 * avoids the gateway needing to distinguish pre-formatted from raw text.
 */

// ---------------------------------------------------------------------------
// Block types (mirrors gateway/src/slack/block-kit-builder.ts)
// ---------------------------------------------------------------------------

interface TextObject {
  type: "mrkdwn" | "plain_text";
  text: string;
}

interface SectionBlock {
  type: "section";
  text: TextObject;
}

interface DividerBlock {
  type: "divider";
}

interface HeaderBlock {
  type: "header";
  text: TextObject;
}

type Block = SectionBlock | DividerBlock | HeaderBlock;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert markdown/plain text into Slack Block Kit blocks.
 *
 * Returns undefined when the input is empty so callers can
 * skip sending the `blocks` field entirely.
 */
export function textToSlackBlocks(text: string): Block[] | undefined {
  if (!text || text.trim().length === 0) return undefined;

  const segments = splitIntoSegments(text);
  const blocks: Block[] = [];

  for (let i = 0; i < segments.length; i++) {
    if (i > 0) {
      blocks.push({ type: "divider" });
    }

    const segment = segments[i];

    if (segment.type === "code") {
      const lang = segment.lang ?? "";
      const codeText = "```" + lang + "\n" + segment.content + "\n```";
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: codeText },
      });
    } else if (segment.type === "header") {
      blocks.push({
        type: "header",
        text: { type: "plain_text", text: segment.content },
      });
    } else if (segment.type === "table") {
      const structured = convertTableToStructuredText(
        segment.headers,
        segment.rows,
      );
      const mrkdwn = markdownToMrkdwn(structured);
      const chunks = splitLongTextSegment(mrkdwn);
      for (let c = 0; c < chunks.length; c++) {
        if (c > 0) {
          blocks.push({ type: "divider" });
        }
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: chunks[c] },
        });
      }
    } else {
      // Transform to Slack mrkdwn FIRST, then split. Splitting raw markdown
      // can bisect `[link text](url)` spans or `**bold**` markers at sentence
      // boundaries inside link text, leaving orphan tokens that the regex in
      // `markdownToMrkdwn` won't match — raw markdown would then leak through
      // to Slack. Splitting already-converted mrkdwn is safe because
      // well-formed `<url|text>` / `*bold*` spans don't contain the `. `,
      // `! `, `? `, or newline delimiters the splitter looks for (and the
      // preceding table branch follows this same ordering).
      const mrkdwn = markdownToMrkdwn(segment.content);
      const chunks = splitLongTextSegment(mrkdwn);
      for (let c = 0; c < chunks.length; c++) {
        if (c > 0) {
          blocks.push({ type: "divider" });
        }
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: chunks[c] },
        });
      }
    }
  }

  return blocks.length > 0 ? blocks : undefined;
}

/**
 * Detect whether a callback URL points to the gateway's Slack delivery endpoint.
 */
export function isSlackCallbackUrl(callbackUrl: string): boolean {
  try {
    const url = new URL(callbackUrl);
    return (
      url.pathname === "/deliver/slack" ||
      url.pathname.startsWith("/deliver/slack?")
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface TextSegment {
  type: "text";
  content: string;
}

interface CodeSegment {
  type: "code";
  content: string;
  lang?: string;
}

interface HeaderSegment {
  type: "header";
  content: string;
}

interface TableSegment {
  type: "table";
  headers: string[];
  rows: string[][];
}

type Segment = TextSegment | CodeSegment | HeaderSegment | TableSegment;

function splitIntoSegments(text: string): Segment[] {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let currentTextLines: string[] = [];

  function flushText(): void {
    const joined = currentTextLines.join("\n").trim();
    if (joined.length > 0) {
      segments.push({ type: "text", content: joined });
    }
    currentTextLines = [];
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = line.match(/^```(\w*)\s*$/);

    if (fenceMatch) {
      flushText();
      const lang = fenceMatch[1] || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].match(/^```\s*$/)) {
        codeLines.push(lines[i]);
        i++;
      }
      segments.push({ type: "code", content: codeLines.join("\n"), lang });
      i++; // skip closing fence
      continue;
    }

    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      flushText();
      segments.push({ type: "header", content: headingMatch[1].trim() });
      i++;
      continue;
    }

    // Detect markdown tables: header row + separator row + data rows
    const tableSegment = tryParseTable(lines, i);
    if (tableSegment) {
      flushText();
      segments.push(tableSegment.segment);
      i = tableSegment.nextIndex;
      continue;
    }

    currentTextLines.push(line);
    i++;
  }

  flushText();
  return segments;
}

/**
 * Parse cells from a pipe-delimited table row, trimming whitespace.
 */
function parseTableRow(line: string): string[] {
  const ESCAPED_PIPE_PLACEHOLDER = "\x00PIPE\x00";
  const ESCAPED_BACKSLASH_PLACEHOLDER = "\x00BSLASH\x00";
  return line
    // First, protect escaped backslashes (\\) so they don't interfere
    .replace(/\\\\/g, ESCAPED_BACKSLASH_PLACEHOLDER)
    // Now a remaining \| is a genuinely escaped pipe (odd backslash)
    .replace(/\\\|/g, ESCAPED_PIPE_PLACEHOLDER)
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) =>
      cell
        .replaceAll(ESCAPED_PIPE_PLACEHOLDER, "|")
        .replaceAll(ESCAPED_BACKSLASH_PLACEHOLDER, "\\\\")
        .trim(),
    );
}

/**
 * Check if a line is a markdown table separator row (e.g., |---|---|).
 */
function isSeparatorRow(line: string): boolean {
  return /^\|[\s:-]+(\|[\s:-]+)*\|?\s*$/.test(line);
}

/**
 * Try to parse a markdown table starting at the given line index.
 * Returns the parsed table segment and the next line index, or null
 * if the lines don't form a valid table (header + separator + at least
 * one data row).
 */
function tryParseTable(
  lines: string[],
  startIndex: number,
): { segment: TableSegment; nextIndex: number } | null {
  // Need at least 3 lines: header, separator, one data row
  if (startIndex + 2 >= lines.length) return null;

  const headerLine = lines[startIndex];
  const separatorLine = lines[startIndex + 1];

  // Header must be a pipe-delimited row
  if (!headerLine.includes("|") || !headerLine.match(/^\|.*\|$/)) return null;
  if (!isSeparatorRow(separatorLine)) return null;

  const headers = parseTableRow(headerLine);

  // Collect data rows
  const rows: string[][] = [];
  let i = startIndex + 2;
  while (
    i < lines.length &&
    lines[i].includes("|") &&
    lines[i].match(/^\|.*\|$/)
  ) {
    if (!isSeparatorRow(lines[i])) {
      rows.push(parseTableRow(lines[i]));
    }
    i++;
  }

  // Need at least one data row to qualify as a table
  if (rows.length === 0) return null;

  return {
    segment: { type: "table", headers, rows },
    nextIndex: i,
  };
}

/**
 * Convert a parsed table into structured bullet-point text suitable
 * for Slack rendering. Uses the first column as the entry label,
 * listing remaining columns as sub-bullets.
 */
function convertTableToStructuredText(
  headers: string[],
  rows: string[][],
): string {
  const lines: string[] = [];

  for (const row of rows) {
    const label = row[0] ?? "";
    lines.push(`**${label}**`);
    for (let c = 1; c < headers.length; c++) {
      const value = row[c] ?? "";
      lines.push(`  - ${headers[c]}: ${value}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function markdownToMrkdwn(text: string): string {
  let result = text;
  // [text](url) → <url|text>
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, linkText, url) => `<${url}|${linkText}>`,
  );
  // **bold** → *bold*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  return result;
}

// ---------------------------------------------------------------------------
// Long-text splitting
// ---------------------------------------------------------------------------

/**
 * Slack's `section` block has a documented ~3000-character limit on the
 * `text.text` value. Keep a margin under that so downstream transforms
 * (e.g. `markdownToMrkdwn` expansions) don't push a chunk over.
 */
export const SLACK_SECTION_MAX_CHARS = 2800;

/**
 * Split `text` into chunks no larger than `maxChars`, preferring natural
 * boundaries. Pure helper: no Block Kit knowledge, safe to unit test.
 *
 * Preference order for split points:
 *  1. Paragraph boundary (`\n\n`)
 *  2. Single newline (`\n`)
 *  3. Sentence boundary (`. `, `! `, `? `)
 *  4. Hard slice at `maxChars`
 *
 * Short inputs (length ≤ `maxChars`) return `[text]` unchanged. Each chunk
 * is trimmed of leading/trailing whitespace at chunk boundaries; interior
 * whitespace is preserved.
 */
export function splitLongTextSegment(
  text: string,
  maxChars: number = SLACK_SECTION_MAX_CHARS,
): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    let splitAt = findBoundary(window, ["\n\n"]);
    if (splitAt < 0) splitAt = findBoundary(window, ["\n"]);
    if (splitAt < 0) splitAt = findBoundary(window, [". ", "! ", "? "]);
    // Hard-slice fallback: no natural boundary in the first `maxChars`.
    if (splitAt < 0) splitAt = maxChars;

    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk.length > 0) chunks.push(chunk);
    remaining = remaining.slice(splitAt);
  }

  const tail = remaining.trim();
  if (tail.length > 0) chunks.push(tail);

  return chunks;
}

/**
 * Return the end index of the last occurrence of any delimiter in `window`
 * (so the preceding content becomes one chunk). Returns -1 if none match.
 */
function findBoundary(window: string, delimiters: string[]): number {
  let best = -1;
  for (const delim of delimiters) {
    const idx = window.lastIndexOf(delim);
    if (idx < 0) continue;
    const end = idx + delim.length;
    if (end > best) best = end;
  }
  return best;
}
