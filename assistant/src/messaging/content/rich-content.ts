/**
 * Channel-neutral structured content model for assistant replies.
 *
 * `parseMarkdownToRichContent` turns a markdown/plain-text reply into a typed
 * `RichContent` tree (paragraphs, headings, code, tables). Each channel adapter
 * renders this tree into its own native format — Slack Block Kit, Telegram Rich
 * Messages, Discord Components, etc. The "what" lives here; the "how" lives in
 * each adapter's renderer. Nothing in this module may import a channel-specific
 * type (no `@slack/types`, no provider modules).
 */

/** A run of prose. The text is markdown; each adapter decides how to render it. */
export interface ParagraphNode {
  type: "paragraph";
  text: string;
}

/** A section heading (markdown ATX levels 1–3). */
export interface HeadingNode {
  type: "heading";
  text: string;
}

/** A fenced code block. `lang` is the info string after the opening fence. */
export interface CodeNode {
  type: "code";
  text: string;
  lang?: string;
}

/** A table: a header row plus zero-padded data rows of trimmed cell text. */
export interface TableNode {
  type: "table";
  headers: string[];
  rows: string[][];
}

export type RichNode = ParagraphNode | HeadingNode | CodeNode | TableNode;

export type RichContent = RichNode[];

/**
 * Parse markdown/plain text into a channel-neutral `RichContent` tree. Detects
 * fenced code blocks, ATX headings (levels 1–3), and pipe-delimited tables;
 * everything else is collected into paragraph nodes broken on blank lines.
 */
export function parseMarkdownToRichContent(text: string): RichContent {
  const lines = text.split("\n");
  const nodes: RichContent = [];
  let currentTextLines: string[] = [];

  function flushText(): void {
    const joined = currentTextLines.join("\n").trim();
    if (joined.length > 0) {
      nodes.push({ type: "paragraph", text: joined });
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
      nodes.push({ type: "code", text: codeLines.join("\n"), lang });
      i++; // skip closing fence
      continue;
    }

    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      flushText();
      nodes.push({ type: "heading", text: headingMatch[1].trim() });
      i++;
      continue;
    }

    // Detect markdown tables: header row + separator row + data rows.
    const table = tryParseTable(lines, i);
    if (table) {
      flushText();
      nodes.push(table.node);
      i = table.nextIndex;
      continue;
    }

    currentTextLines.push(line);
    i++;
  }

  flushText();
  return nodes;
}

/**
 * Parse cells from a pipe-delimited table row, trimming whitespace and honoring
 * escaped pipes (`\|`) and escaped backslashes (`\\`).
 */
function parseTableRow(line: string): string[] {
  const ESCAPED_PIPE_PLACEHOLDER = "\x00PIPE\x00";
  const ESCAPED_BACKSLASH_PLACEHOLDER = "\x00BSLASH\x00";
  return (
    line
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
      )
  );
}

/** Check if a line is a markdown table separator row (e.g., |---|---|). */
function isSeparatorRow(line: string): boolean {
  return /^\|[\s:-]+(\|[\s:-]+)*\|?\s*$/.test(line);
}

/**
 * Try to parse a markdown table starting at the given line index. Returns the
 * parsed table node and the next line index, or null if the lines don't form a
 * valid table (header + separator + at least one data row).
 */
function tryParseTable(
  lines: string[],
  startIndex: number,
): { node: TableNode; nextIndex: number } | null {
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
    node: { type: "table", headers, rows },
    nextIndex: i,
  };
}
