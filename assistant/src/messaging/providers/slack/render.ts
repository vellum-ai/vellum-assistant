/**
 * Slack Block Kit rendering: mdast → Slack blocks.
 *
 * The channel-neutral parse (markdown → mdast) lives in `messaging/content`;
 * this module is Slack's "how". Prose, lists, quotes, and code render to Slack
 * `markdown` blocks (native GFM, 12k-char limit) sliced straight from the
 * original source by node position — so there is no inline→mrkdwn serializer to
 * hand-roll. Headings become `header` blocks, GFM tables become `table` blocks
 * (with Slack's row / column / character caps), and a `---` becomes a divider.
 */

import type { KnownBlock, RawTextElement, TableBlock } from "@slack/types";
import type {
  Heading,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableRow,
} from "mdast";

import { parseMarkdown } from "../../content/parse.js";

/** Slack rejects messages with more than 50 Block Kit blocks. */
const SLACK_BLOCK_LIMIT = 50;
/** A `markdown` block's text is capped at 12,000 characters. */
const SLACK_MARKDOWN_MAX_CHARS = 12_000;
/**
 * Slack also caps the *cumulative* `markdown`-block text across a single message
 * payload, not just per block — an over-limit payload is rejected as
 * `invalid_blocks`. The exact ceiling isn't documented in `@slack/types`; 12,000
 * is conservative (it matches the documented per-block limit and stays under the
 * observed cumulative threshold). Past it, the reply is delivered as plain text
 * rather than risking rejection.
 */
const SLACK_MARKDOWN_PAYLOAD_MAX_CHARS = 12_000;
/** A `header` block's plain_text is capped at 150 characters. */
const SLACK_HEADER_MAX_CHARS = 150;
/**
 * Slack `table` blocks allow at most 100 rows (the mdast header row counts), 20
 * columns, and 10,000 cell characters — the 10k applies both per table and in
 * aggregate across every table in one message.
 */
const SLACK_TABLE_MAX_ROWS = 100;
const SLACK_TABLE_MAX_COLUMNS = 20;
const SLACK_TABLE_MAX_TOTAL_CHARS = 10_000;

/**
 * Render markdown / plain text into Slack Block Kit blocks, or `undefined` when
 * the input is empty so callers can skip the `blocks` field entirely.
 */
export function renderSlackBlocks(text: string): KnownBlock[] | undefined {
  if (!text || text.trim().length === 0) return undefined;
  const blocks = renderSlack(parseMarkdown(text), text);
  return blocks.length > 0 ? blocks : undefined;
}

/**
 * Render an mdast tree to Slack blocks. `source` is the original markdown the
 * tree was parsed from; prose runs are sliced from it by node position so the
 * `markdown` blocks carry the exact GFM the user wrote.
 */
export function renderSlack(tree: Root, source: string): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  let run: RootContent[] = [];
  let tableCharsUsed = 0;

  const flushRun = (): void => {
    if (run.length === 0) return;
    for (const chunk of runToMarkdownChunks(run, source)) {
      blocks.push({ type: "markdown", text: chunk });
    }
    run = [];
  };

  for (const node of tree.children) {
    if (node.type === "heading") {
      flushRun();
      blocks.push(headingBlock(node));
    } else if (node.type === "table") {
      flushRun();
      const built = tryTableBlock(node, tableCharsUsed);
      if (built) {
        blocks.push(built.block);
        tableCharsUsed += built.cellChars;
      } else {
        // Too big for a `table` block (Slack would reject the payload). Fall
        // back to the raw table markdown in `markdown` blocks so the content
        // still shows, just not as a rendered table.
        for (const chunk of splitAtLines(sliceNode(node, source))) {
          if (chunk.length > 0) blocks.push({ type: "markdown", text: chunk });
        }
      }
    } else if (node.type === "thematicBreak") {
      flushRun();
      blocks.push({ type: "divider" });
    } else {
      run.push(node);
    }
  }
  flushRun();

  // Slack caps cumulative `markdown`-block text per payload (see
  // SLACK_MARKDOWN_PAYLOAD_MAX_CHARS). If the rendered markdown would exceed it,
  // deliver the whole reply as plain text instead of a reject-prone payload —
  // the same outcome as the `invalid_blocks` retry, but without the failed
  // round trip. Returning an empty array makes the caller fall back to `text`.
  const markdownChars = blocks.reduce(
    (sum, block) => (block.type === "markdown" ? sum + block.text.length : sum),
    0,
  );
  if (markdownChars > SLACK_MARKDOWN_PAYLOAD_MAX_CHARS) return [];

  return capBlocks(blocks);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Slice a node's exact source markdown using its parse position. */
function sliceNode(node: RootContent, source: string): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return "";
  return source.slice(start, end);
}

/**
 * Turn a run of ordinary (non-heading / non-table / non-rule) nodes into
 * `markdown`-block-sized chunks, splitting at node boundaries so a chunk never
 * bisects a node unless that single node is itself over the limit.
 */
function runToMarkdownChunks(run: RootContent[], source: string): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const node of run) {
    const md = sliceNode(node, source).trim();
    if (md.length === 0) continue;

    if (md.length > SLACK_MARKDOWN_MAX_CHARS) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitAtLines(md));
      continue;
    }

    if (
      current.length > 0 &&
      current.length + 2 + md.length > SLACK_MARKDOWN_MAX_CHARS
    ) {
      chunks.push(current);
      current = "";
    }
    current = current.length > 0 ? `${current}\n\n${md}` : md;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Split text into ≤`max` chunks, preferring line boundaries, hard-slicing only an over-long single line. */
function splitAtLines(
  text: string,
  max: number = SLACK_MARKDOWN_MAX_CHARS,
): string[] {
  if (text.length <= max) return [text];

  const chunks: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    if (line.length > max) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += max) {
        chunks.push(line.slice(i, i + max));
      }
      continue;
    }
    if (current.length > 0 && current.length + 1 + line.length > max) {
      chunks.push(current);
      current = "";
    }
    current = current.length > 0 ? `${current}\n${line}` : line;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** A `header` block from a heading node (plain text, formatting stripped, ≤150 chars). */
function headingBlock(node: Heading): KnownBlock {
  const text = serializePlain(node.children).slice(0, SLACK_HEADER_MAX_CHARS);
  return {
    type: "header",
    text: {
      type: "plain_text",
      text: text.length > 0 ? text : " ",
      emoji: true,
    },
  };
}

/**
 * Build a Slack `table` block from a GFM table node, or `null` when it exceeds
 * Slack's limits (so the caller falls back to text). `charsUsed` is the running
 * per-message table-cell total; a table that would push it over 10,000 also
 * returns `null`. Cells are `raw_text` (markdown inside a cell is flattened to
 * plain text — rich-text cells would be a future enhancement).
 */
function tryTableBlock(
  node: Table,
  charsUsed: number,
): { block: TableBlock; cellChars: number } | null {
  const rows = node.children;
  const columnCount = Math.max(0, ...rows.map((row) => row.children.length));
  if (columnCount === 0 || columnCount > SLACK_TABLE_MAX_COLUMNS) return null;
  if (rows.length > SLACK_TABLE_MAX_ROWS) return null;

  const toCells = (row: TableRow): RawTextElement[] =>
    Array.from({ length: columnCount }, (_, c) => {
      const cell = row.children[c];
      const text = cell ? serializePlain(cell.children) : "";
      // `raw_text` requires at least one character.
      return { type: "raw_text", text: text.length > 0 ? text : " " };
    });

  const tableRows = rows.map(toCells);
  const cellChars = tableRows.reduce(
    (sum, row) =>
      sum + row.reduce((rowSum, cell) => rowSum + cell.text.length, 0),
    0,
  );
  if (cellChars > SLACK_TABLE_MAX_TOTAL_CHARS) return null;
  if (charsUsed + cellChars > SLACK_TABLE_MAX_TOTAL_CHARS) return null;

  return { block: { type: "table", rows: tableRows }, cellChars };
}

/** Flatten inline phrasing content to plain text (used for headers and table cells). */
function serializePlain(nodes: PhrasingContent[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += node.value;
        break;
      case "inlineCode":
        out += node.value;
        break;
      case "break":
        out += " ";
        break;
      case "image":
        out += node.alt ?? "";
        break;
      case "strong":
      case "emphasis":
      case "delete":
      case "link":
        out += serializePlain(node.children);
        break;
      default:
        if ("children" in node) {
          out += serializePlain(node.children as PhrasingContent[]);
        }
    }
  }
  return out;
}

/** Cap output at Slack's 50-block limit, appending a truncation note when over. */
function capBlocks(blocks: KnownBlock[]): KnownBlock[] {
  if (blocks.length <= SLACK_BLOCK_LIMIT) return blocks;
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
