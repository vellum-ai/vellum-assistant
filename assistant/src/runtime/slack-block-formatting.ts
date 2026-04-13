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
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: markdownToMrkdwn(structured) },
      });
    } else {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: markdownToMrkdwn(segment.content) },
      });
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
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
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
