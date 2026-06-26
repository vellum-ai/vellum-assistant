/**
 * Slack Block Kit rendering for channel replies.
 *
 * Renders a channel-neutral `RichContent` tree (produced by
 * `parseMarkdownToRichContent`) into Slack Block Kit blocks: code fences,
 * headings, markdown tables, and oversize-section splitting. The markdown →
 * structure parsing lives in `messaging/content/rich-content.ts`; this module
 * is the Slack-specific "how".
 */

import type { KnownBlock, RawTextElement, TableBlock } from "@slack/types";

import type { RichContent } from "../messaging/content/rich-content.js";
import { parseMarkdownToRichContent } from "../messaging/content/rich-content.js";

/** Slack rejects messages with more than 50 Block Kit blocks. */
const SLACK_BLOCK_LIMIT = 50;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert markdown/plain text into Slack Block Kit blocks.
 *
 * Returns undefined when the input is empty so callers can
 * skip sending the `blocks` field entirely.
 */
export function textToSlackBlocks(text: string): KnownBlock[] | undefined {
  if (!text || text.trim().length === 0) return undefined;
  const blocks = renderRichContentToBlocks(parseMarkdownToRichContent(text));
  return blocks.length > 0 ? blocks : undefined;
}

/**
 * Render a channel-neutral `RichContent` tree into Slack Block Kit blocks.
 * Each node becomes one or more blocks separated by dividers, and oversize
 * code, tables, and prose degrade gracefully (see the per-branch comments).
 * Output is capped at `SLACK_BLOCK_LIMIT`, with a truncation note appended
 * when the cap is hit.
 */
function renderRichContentToBlocks(nodes: RichContent): KnownBlock[] {
  const blocks: KnownBlock[] = [];

  for (let i = 0; i < nodes.length; i++) {
    if (i > 0) {
      blocks.push({ type: "divider" });
    }

    const node = nodes[i];

    if (node.type === "code") {
      const lang = node.lang ?? "";
      const codeChunks = splitCodeSegmentContent(node.text, lang);
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
    } else if (node.type === "heading") {
      blocks.push({
        type: "header",
        text: { type: "plain_text", text: node.text },
      });
    } else if (node.type === "table") {
      const tableBlock = tryBuildTableBlock(node.headers, node.rows);
      if (tableBlock) {
        blocks.push(tableBlock);
      } else {
        // Table exceeds Slack's table-block limits (≤100 rows / ≤20 columns /
        // ≤10,000 chars across cells); fall back to structured bullet text
        // split across section blocks so an oversize table degrades on its own
        // rather than failing the payload.
        const structured = convertTableToStructuredText(
          node.headers,
          node.rows,
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
      const mrkdwn = markdownToMrkdwn(node.text);
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

  if (blocks.length > SLACK_BLOCK_LIMIT) {
    // Slack rejects payloads with more than 50 blocks. Keep the first 49 and
    // append a context note so long content degrades gracefully instead of
    // failing the entire Block Kit payload with invalid_blocks.
    const omitted = blocks.length - (SLACK_BLOCK_LIMIT - 1);
    return [
      ...blocks.slice(0, SLACK_BLOCK_LIMIT - 1),
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `_${omitted} more block${omitted === 1 ? "" : "s"} omitted (Slack's ${SLACK_BLOCK_LIMIT}-block limit)._`,
          },
        ],
      },
    ];
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Slack `table` blocks allow at most 100 rows (incl. the header) and 20 columns. */
const SLACK_TABLE_MAX_ROWS = 100;
const SLACK_TABLE_MAX_COLUMNS = 20;
/** Slack rejects a `table` block whose cell text totals more than 10,000 characters. */
const SLACK_TABLE_MAX_TOTAL_CHARS = 10_000;

/**
 * Build a Slack `table` block from a parsed markdown table, or `null` when the
 * table exceeds Slack's table-block limits — ≤100 rows (incl. the header), ≤20
 * columns, and ≤10,000 characters across all cells — so the caller can fall
 * back to a text rendering. (An over-limit table is rejected as
 * `invalid_blocks`, which drops every block in the message, so gating here lets
 * an oversize table degrade to text on its own.) The header row is emitted
 * first. Cells are `raw_text`; markdown inside a cell is not re-rendered
 * (rich-text cells would be a future enhancement). Short rows are padded so
 * every row has the same cell count.
 */
function tryBuildTableBlock(
  headers: string[],
  rows: string[][],
): TableBlock | null {
  const columnCount = Math.max(
    headers.length,
    ...rows.map((row) => row.length),
  );
  if (columnCount === 0 || columnCount > SLACK_TABLE_MAX_COLUMNS) return null;
  if (rows.length + 1 > SLACK_TABLE_MAX_ROWS) return null;

  const toCells = (cells: string[]): RawTextElement[] =>
    Array.from({ length: columnCount }, (_, c) => {
      const text = cells[c] ?? "";
      // `raw_text` requires at least one character.
      return { type: "raw_text", text: text.length > 0 ? text : " " };
    });

  const tableRows = [toCells(headers), ...rows.map(toCells)];

  // Slack caps the total character count across all cells in a table at 10,000
  // (empty cells count as their single padding space); over that, Slack rejects
  // the block, so fall back to the text rendering instead.
  const totalCellChars = tableRows
    .flat()
    .reduce((sum, cell) => sum + cell.text.length, 0);
  if (totalCellChars > SLACK_TABLE_MAX_TOTAL_CHARS) return null;

  return {
    type: "table",
    rows: tableRows,
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
 * Slack link/mention tokens always start with one of these prefixes after
 * the opening `<`. A plain `<` in technical prose (e.g. `a < b`) does not
 * match any of these and must not be treated as a span start, or the
 * splitter would reject every boundary past the `<` and fall back to a
 * hard slice that can land mid-word.
 */
const SLACK_LINK_PREFIXES = [
  "http://",
  "https://",
  "mailto:",
  "#C", // channel ref: <#C0123ABCD|name>
  "@U", // user mention: <@U0123ABCD>
  "@W", // workspace user: <@W0123ABCD>
  "!channel",
  "!here",
  "!everyone",
  "!subteam",
  "!date",
];

// Matches `scheme://` at the start of a string where `scheme` follows RFC 3986
// syntax: `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`. Covers http, https,
// ftp, ssh, git+ssh, custom app schemes, etc.
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function looksLikeLinkStart(window: string, openIdx: number): boolean {
  const rest = window.slice(openIdx + 1);
  if (rest.length === 0) return false;
  const first = rest.charCodeAt(0);
  // Fast reject: whitespace or another `<` immediately after `<` is never a link.
  if (first === 0x20 || first === 0x09 || first === 0x0a || first === 0x3c) {
    return false;
  }
  for (const prefix of SLACK_LINK_PREFIXES) {
    if (rest.startsWith(prefix)) return true;
    // Near the window edge the prefix may be truncated — e.g. `<https`
    // when `://` is past the cutoff. If `rest` is a strict prefix of a
    // known link prefix, treat it as link-shaped so the continuation
    // past the window is still protected from mid-token hard slicing.
    if (rest.length < prefix.length && prefix.startsWith(rest)) return true;
  }
  // `markdownToMrkdwn` wraps any markdown link target in `<url|text>`,
  // including schemes beyond the whitelist above (ftp, ssh, custom app
  // schemes, etc.). Recognize any `scheme://` prefix so those spans are
  // protected too. Also treat a truncated `<scheme` at the window edge as
  // link-shaped so the continuation past the window is not hard-sliced.
  if (URL_SCHEME_RE.test(rest)) return true;
  const colonIdx = rest.indexOf(":");
  if (colonIdx < 0) {
    if (/^[a-z][a-z0-9+.-]*$/i.test(rest)) return true;
  } else if (colonIdx + 1 === rest.length) {
    if (/^[a-z][a-z0-9+.-]*:$/i.test(rest)) return true;
  } else if (rest[colonIdx + 1] === "/" && colonIdx + 2 === rest.length) {
    if (/^[a-z][a-z0-9+.-]*:\/$/i.test(rest)) return true;
  }
  return false;
}

/**
 * Find half-open intervals `[start, end)` covering Slack mrkdwn spans in
 * `window` that the splitter must not bisect: `<...>` link/mention tokens
 * and `*...*` single-asterisk bold runs. A `<` is only treated as a span
 * start when it is followed by a recognized Slack link/mention prefix
 * (see `SLACK_LINK_PREFIXES`); plain `<` in technical text is skipped.
 * An unclosed link-shaped `<...` is treated as a span extending to the
 * end of the window so the splitter avoids landing inside a span that
 * straddles the cutoff.
 */
function computeMrkdwnSpans(window: string): Array<[number, number]> {
  const intervals: Array<[number, number]> = [];

  let i = 0;
  while (i < window.length) {
    const open = window.indexOf("<", i);
    if (open < 0) break;
    if (!looksLikeLinkStart(window, open)) {
      i = open + 1;
      continue;
    }
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

function isInsideSpan(pos: number, spans: Array<[number, number]>): boolean {
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
