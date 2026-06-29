/**
 * Slack Block Kit rendering: mdast → Slack blocks.
 *
 * The channel-neutral parse (markdown → mdast) lives in `messaging/content`;
 * this module is Slack's "how". It maps each top-level mdast node to its
 * natural Slack block: a heading → `header`, a GFM table → `table` (or markdown
 * when it exceeds Slack's table limits), a thematic break → `divider`, and every
 * other run of content → a `markdown` block carrying the exact original GFM,
 * sliced from the source by node position (so there is no inline → mrkdwn
 * serializer to hand-roll).
 *
 * Scope: this renderer enforces only Slack's documented *per-element* limits —
 * a header's 150 characters, a table's row / column / cell budgets. It does NOT
 * police whole-message size (total block count, or cumulative `markdown` text).
 * Those ceilings — the 50-block limit, and an undocumented cumulative-markdown
 * limit Slack surfaces as `msg_blocks_too_long` around ~13k characters — are the
 * transport's responsibility: `send.ts` posts the blocks and resends the
 * message as plain text if Slack rejects the payload. Keeping size policy at the
 * send boundary lets Slack stay the authority on its own limits and keeps this
 * module a straight mapping with no guessed byte ceiling.
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
    const md = sliceRun(run, source);
    if (md.length > 0) blocks.push({ type: "markdown", text: md });
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
        // Too big for a `table` block (Slack would reject it). Keep the content
        // as its raw table markdown so it still shows, just not as a rendered
        // table.
        const md = sliceNode(node, source).trim();
        if (md.length > 0) blocks.push({ type: "markdown", text: md });
      }
    } else if (node.type === "thematicBreak") {
      flushRun();
      blocks.push({ type: "divider" });
    } else {
      run.push(node);
    }
  }
  flushRun();

  return blocks;
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
 * Slice a run of consecutive ordinary (non-heading / non-table / non-rule)
 * nodes back to one markdown string, spanning the first node's start to the last
 * node's end so the original GFM — and the blank lines between nodes — is
 * preserved verbatim. Returns "" for an empty run.
 */
function sliceRun(run: RootContent[], source: string): string {
  if (run.length === 0) return "";
  const start = run[0]?.position?.start.offset;
  const end = run[run.length - 1]?.position?.end.offset;
  if (start === undefined || end === undefined) return "";
  return source.slice(start, end).trim();
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
