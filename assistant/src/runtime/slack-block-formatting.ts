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
      const codeChunks = splitCodeSegmentContent(segment.content, lang);
      for (let c = 0; c < codeChunks.length; c++) {
        if (c > 0) {
          blocks.push({ type: "divider" });
        }
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: "```" + lang + "\n" + codeChunks[c] + "\n```",
          },
        });
      }
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
      // can bisect `[link text](url)` spans or `**bold**` markers, leaving
      // orphan tokens that `markdownToMrkdwn`'s regex won't match — raw
      // markdown would then leak through to Slack. The splitter is also
      // span-aware (see `splitLongTextSegment`) so candidate boundaries
      // landing inside a `<url|text>` or `*bold*` span are rejected, which
      // matters when link text contains `. `/`! `/`? ` (e.g.
      // `<url|First sentence. Second sentence>`) or when a span straddles
      // the maxChars window. The preceding table branch uses the same
      // ordering.
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
 *  4. Hard slice at `maxChars` (backed up to the start of any straddling
 *     mrkdwn span, when possible)
 *
 * Span-aware: candidate boundaries that fall strictly inside a Slack
 * `<...>` link/user token or a `*...*` bold span are rejected so chunks
 * never end with an unclosed `<` or orphan `*`. This matters because
 * `markdownToMrkdwn` runs before splitting, and link text can legitimately
 * contain `. `/`! `/`? ` (e.g. `<url|First sentence. Second sentence>`).
 *
 * Short inputs (length ≤ `maxChars`) return `[text]` unchanged. Each chunk
 * is trimmed of leading/trailing whitespace at chunk boundaries; interior
 * whitespace is preserved.
 */
export function splitLongTextSegment(
  text: string,
  maxChars: number = SLACK_SECTION_MAX_CHARS,
): string[] {
  if (maxChars <= 0 || text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const spans = computeMrkdwnSpans(window);
    let splitAt = findBoundary(window, ["\n\n"], spans);
    if (splitAt < 0) splitAt = findBoundary(window, ["\n"], spans);
    if (splitAt < 0) splitAt = findBoundary(window, [". ", "! ", "? "], spans);
    if (splitAt < 0) splitAt = hardSliceAvoidingSpans(maxChars, spans);

    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk.length > 0) chunks.push(chunk);
    remaining = remaining.slice(splitAt);
  }

  const tail = remaining.trim();
  if (tail.length > 0) chunks.push(tail);

  return chunks;
}

/**
 * Find half-open intervals `[start, end)` covering Slack mrkdwn spans in
 * `window` that the splitter must not bisect: `<...>` tokens (links, user
 * mentions, channel refs) and `*...*` single-asterisk bold runs. An
 * unclosed `<` is treated as a span extending to the end of the window so
 * the splitter avoids landing inside a span that straddles the cutoff.
 */
function computeMrkdwnSpans(window: string): Array<[number, number]> {
  const intervals: Array<[number, number]> = [];

  let i = 0;
  while (i < window.length) {
    const open = window.indexOf("<", i);
    if (open < 0) break;
    const close = window.indexOf(">", open + 1);
    // For unclosed `<...` (span continues past the window), use a sentinel
    // larger than any in-window position so split-point checks treat the
    // window's right edge as inside the span and back the hard-slice up.
    const end = close < 0 ? window.length + 1 : close + 1;
    intervals.push([open, end]);
    i = close < 0 ? window.length : end;
  }

  // Bold spans cannot contain `*` or `\n`.
  const boldRe = /\*[^*\n]+\*/g;
  let m: RegExpExecArray | null;
  while ((m = boldRe.exec(window)) !== null) {
    intervals.push([m.index, m.index + m[0].length]);
  }

  return intervals;
}

function isInsideSpan(
  pos: number,
  spans: Array<[number, number]>,
): boolean {
  for (const [start, end] of spans) {
    if (pos > start && pos < end) return true;
  }
  return false;
}

function hardSliceAvoidingSpans(
  maxChars: number,
  spans: Array<[number, number]>,
): number {
  for (const [start, end] of spans) {
    if (maxChars > start && maxChars < end) {
      // Back up to the start of the straddling span so it stays intact in
      // the next chunk. If the span starts at 0, we have no choice but to
      // hard-slice through it.
      return start > 0 ? start : maxChars;
    }
  }
  return maxChars;
}

/**
 * Split a code segment's inner content into chunks that, once wrapped in
 * ```lang … ``` fences, each fit inside Slack's section-text limit.
 *
 * Prefers line boundaries so code stays readable across chunks; falls back
 * to a hard character slice for pathological single-line content.
 */
export function splitCodeSegmentContent(
  content: string,
  lang: string = "",
  maxChars: number = SLACK_SECTION_MAX_CHARS,
): string[] {
  // Fence overhead: "```" + lang + "\n" + content + "\n```"
  const overhead = 3 + lang.length + 1 + 1 + 3;
  const budget = maxChars - overhead;
  if (budget <= 0 || content.length <= budget) return [content];

  const chunks: string[] = [];
  const lines = content.split("\n");
  let current: string[] = [];
  let currentLen = 0;

  const flush = (): void => {
    if (current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
      currentLen = 0;
    }
  };

  for (const line of lines) {
    // +1 for the joining "\n" (only if current is non-empty)
    const added = current.length === 0 ? line.length : line.length + 1;
    if (currentLen + added <= budget) {
      current.push(line);
      currentLen += added;
      continue;
    }

    flush();

    // A single line longer than the budget — hard-slice it across chunks.
    if (line.length > budget) {
      let remaining = line;
      while (remaining.length > budget) {
        chunks.push(remaining.slice(0, budget));
        remaining = remaining.slice(budget);
      }
      if (remaining.length > 0) {
        current.push(remaining);
        currentLen = remaining.length;
      }
    } else {
      current.push(line);
      currentLen = line.length;
    }
  }

  flush();
  return chunks;
}

/**
 * Return the end index of the last occurrence of any delimiter in `window`
 * whose split point does not fall inside a mrkdwn span. Returns -1 if no
 * delimiter has a valid split point.
 */
function findBoundary(
  window: string,
  delimiters: string[],
  spans: Array<[number, number]> = [],
): number {
  let best = -1;
  for (const delim of delimiters) {
    let from = window.length;
    while (from > 0) {
      const idx = window.lastIndexOf(delim, from - 1);
      if (idx < 0) break;
      const end = idx + delim.length;
      if (!isInsideSpan(end, spans)) {
        if (end > best) best = end;
        break;
      }
      from = idx;
    }
  }
  return best;
}
