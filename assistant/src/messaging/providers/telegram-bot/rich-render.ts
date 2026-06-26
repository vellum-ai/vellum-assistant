/**
 * Telegram Rich Messages rendering for channel replies.
 *
 * Renders a channel-neutral `RichContent` tree (from `parseMarkdownToRichContent`)
 * into Telegram Bot API 10.1 "rich blocks" — the `sendRichMessage` payload.
 * This is the Telegram analogue of the Slack Block Kit renderer: SAME input,
 * different native output. Put the two side by side and the channel-adapter
 * seam is exactly this function's signature — `RichContent -> native blocks`.
 *
 * Two things to notice versus the Slack renderer, both of which live entirely
 * BELOW the seam (i.e. they are Telegram's concern, not the caller's):
 *   - Telegram rich text is GitHub-Flavored Markdown, so prose and cell text
 *     pass through unchanged — there is no mrkdwn conversion and no per-block
 *     character splitting (both Slack-specific).
 *   - Code is a native `preformatted` block, not a fenced `section`.
 *
 * NOTE: the block taxonomy below follows Telegram's documented Bot API 10.1
 * class list (RichBlockParagraph / RichBlockSectionHeading / RichBlockPreformatted
 * / RichBlockTable / RichBlockTableCell / RichBlockDivider). The exact JSON field
 * names must be confirmed against the live API reference before this ships as
 * part of LUM-2434 — the reference is not reachable from this environment.
 */

import type { RichContent } from "../../content/rich-content.js";

export interface RichBlockParagraph {
  type: "paragraph";
  /** GitHub-Flavored Markdown; rendered natively by Telegram. */
  text: string;
}

export interface RichBlockSectionHeading {
  type: "section_heading";
  text: string;
}

export interface RichBlockPreformatted {
  type: "preformatted";
  text: string;
  language?: string;
}

export interface RichBlockTableCell {
  /** Cell text is GFM, so inline links/bold render (unlike Slack `raw_text`). */
  text: string;
}

export interface RichBlockTable {
  type: "table";
  rows: RichBlockTableCell[][];
}

export interface RichBlockDivider {
  type: "divider";
}

export type TelegramRichBlock =
  | RichBlockParagraph
  | RichBlockSectionHeading
  | RichBlockPreformatted
  | RichBlockTable
  | RichBlockDivider;

/**
 * Render a channel-neutral `RichContent` tree into Telegram rich blocks.
 *
 * Note what this function does NOT need: no markdown→mrkdwn conversion, no
 * 3000-char section splitting, no 50-block cap, no table character cap. Those
 * are all Slack limits handled in the Slack renderer. The shared work
 * (markdown → `RichContent`) already happened upstream; this is pure mapping.
 */
export function renderRichContentToTelegram(
  content: RichContent,
): TelegramRichBlock[] {
  const blocks: TelegramRichBlock[] = [];

  for (const node of content) {
    switch (node.type) {
      case "paragraph":
        blocks.push({ type: "paragraph", text: node.text });
        break;
      case "heading":
        blocks.push({ type: "section_heading", text: node.text });
        break;
      case "code":
        blocks.push({
          type: "preformatted",
          text: node.text,
          ...(node.lang ? { language: node.lang } : {}),
        });
        break;
      case "table":
        blocks.push(buildTelegramTable(node.headers, node.rows));
        break;
    }
  }

  return blocks;
}

/**
 * Build a Telegram `table` rich block. The header is the first row; cells carry
 * GFM text. Telegram does not impose Slack's 20-column / 10k-character table
 * caps, so there is no fallback-to-text path here — another divergence that
 * belongs below the seam.
 */
function buildTelegramTable(
  headers: string[],
  rows: string[][],
): RichBlockTable {
  const columnCount = Math.max(
    headers.length,
    ...rows.map((row) => row.length),
  );
  const toCells = (cells: string[]): RichBlockTableCell[] =>
    Array.from({ length: columnCount }, (_, c) => ({ text: cells[c] ?? "" }));

  return {
    type: "table",
    rows: [toCells(headers), ...rows.map(toCells)],
  };
}
